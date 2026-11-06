import path from "node:path";
import type { ResponseFrame, SessionsResolveParams } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewayBrowserClientOptions } from "../api/gateway.ts";
import { INTERNAL_SESSION_PATH_PARAM } from "../app-route-paths.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import type { ApplicationContext, ApplicationContextRequest } from "../app/context.ts";
import type { ChatRouteData } from "../pages/chat/session-route-data.ts";
import type {
  MockGatewayRequest,
  MockGatewayWindow,
} from "../test-helpers/control-ui-e2e-contract.ts";
import { installControlUiE2ePageDiagnosticRing } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { readOutboxQueue } from "./chat-outbox-payloads.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const suite = createControlUiE2eSuite({ name: "Snapshot route admission" });
const id = "b1c2cd3c-1234-4321-9876-123456789abc";
const sessionKey = `agent:main:chat:${id}`;
const transcript = "The cached conversation is ready before route resolution.";
const row = createControlUiSessionRow(sessionKey, "Snapshot conversation", 1);

// Serialized into this suite's mock init script; the existing private console ring owns storage.
function captureSnapshotRouteEvidence(sessionPathParam: string): void {
  const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
  const methods = new Set(["sessions.resolve", "sessions.describe", "chat.startup"]);
  const seen = new WeakSet<object>();
  let loads = 0;
  const reason = (error: unknown) => (error instanceof Error ? error.name : "unknown");
  const record = (event: string, read: () => object | undefined) => {
    try {
      const facts = read();
      if (facts) {
        console.debug(
          "[snapshot-route] " +
            JSON.stringify({
              at: performance.timeOrigin + performance.now(),
              document: performance.timeOrigin,
              event,
              ...facts,
            }),
        );
      }
    } catch {
      /* Passive evidence must preserve original results and exceptions. */
    }
  };
  const identity = (value: unknown) => {
    type Row = { key?: string; sessionKey?: string; agentId?: string };
    const envelope = value as (Row & { session?: Row; sessionInfo?: Row }) | undefined;
    const session = envelope?.session ?? envelope?.sessionInfo ?? envelope;
    return { key: session?.key ?? session?.sessionKey ?? null, agentId: session?.agentId ?? null };
  };
  const key = (request?: MockGatewayRequest) => {
    const params = request?.params as { reference?: unknown } | undefined;
    return identity(params?.reference ?? params).key;
  };
  const data = (value: unknown) => {
    const route = value as ChatRouteData | undefined;
    return route?.kind === "session"
      ? {
          kind: route.kind,
          ...identity(route),
          cache: route.sessionResolutionFromCache,
          canonical: route.canonicalLocation?.pathname,
          source: route.canonicalLocationSource?.pathname,
          canonicalPending: Boolean(route.canonicalLocationReady),
        }
      : { kind: route?.kind ?? null };
  };
  const tap = <F extends (...args: never[]) => unknown>(
    original: F,
    event: string,
    facts: (args: Parameters<F>) => object | undefined,
  ): F =>
    new Proxy(original, {
      apply(target, receiver, args) {
        record(event, () => facts(args as Parameters<F>));
        return Reflect.apply(target, receiver, args);
      },
    });
  for (const method of ["pushState", "replaceState"] as const) {
    history[method] = tap(history[method], "history." + method, (args) => ({
      from: location.pathname,
      to: args[2] == null ? null : new URL(String(args[2]), location.href).pathname,
      source: new Error().stack,
    }));
  }
  mock.resolveDeferred = tap(mock.resolveDeferred, "mock.release", ([method, reply]) =>
    methods.has(method) ? { method, reply: identity(reply) } : undefined,
  );
  // Mock sockets are EventTargets, not network sockets. Read the existing request list after delivery.
  // oxlint-disable-next-line typescript/unbound-method -- Proxy.apply preserves the intercepted socket receiver.
  WebSocket.prototype.dispatchEvent = new Proxy(WebSocket.prototype.dispatchEvent, {
    apply(target, receiver, args: [Event]) {
      const result: unknown = Reflect.apply(target, receiver, args);
      record("mock.reply.dispatched", () => {
        const event = args[0];
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
          return undefined;
        }
        const frame = JSON.parse(event.data) as ResponseFrame;
        const request = mock.requests.find((candidate) => candidate.id === frame.id);
        return frame.type === "res" && request && methods.has(request.method)
          ? {
              id: frame.id,
              method: request.method,
              key: key(request),
              ok: frame.ok,
              reply: identity(frame.payload),
            }
          : undefined;
      });
      return result;
    },
  });
  const attach = (context: ApplicationContext) => {
    if (seen.has(context)) {
      return;
    }
    seen.add(context);
    // bootstrap's native context supplies the full router; no product API or readiness load.
    const router = context.router as ApplicationRuntime["router"];
    router.navigate = tap(router.navigate, "navigation", ([routeId, , options, location]) => ({
      routeId,
      pathname: location?.pathname,
      mode: options?.history,
      source: new Error().stack,
    }));
    const clientChanged = () =>
      record("rpc.observer", () => {
        const client = context.gateway.snapshot.client;
        if (!client || seen.has(client)) {
          return undefined;
        }
        seen.add(client);
        // Existing timing seam also covers requests issued before context publication.
        // gateway.ts retains opts and reads this callback at each protocol settlement.
        const options = Reflect.get(client, "opts") as GatewayBrowserClientOptions;
        const original = options.onRequestTiming;
        options.onRequestTiming = function (this: GatewayBrowserClientOptions, timing) {
          try {
            original?.call(this, timing);
          } finally {
            record("rpc.settled", () =>
              methods.has(timing.method)
                ? {
                    id: timing.id,
                    method: timing.method,
                    key: key(mock.requests.find((candidate) => candidate.id === timing.id)),
                    ok: timing.ok,
                    reason: timing.errorCode,
                    startedAtMs: timing.startedAtMs,
                    endedAtMs: timing.endedAtMs,
                  }
                : undefined,
            );
          }
        };
        return {};
      });
    clientChanged();
    context.gateway.subscribe(clientChanged);
    const route = router.getRoute("chat");
    if (route?.loader) {
      const loader = route.loader;
      route.loader = new Proxy(loader, {
        apply(target, receiver, args: Parameters<typeof loader>) {
          const [, options] = args;
          const facts = {
            load: ++loads,
            cause: options.cause,
            requestedKey: null as string | null,
            reference:
              new URLSearchParams(options.location.search).get(sessionPathParam) ??
              options.location.pathname,
          };
          record("route.requested", () => {
            const prior = data(router.getState().matches[0]?.data);
            facts.requestedKey =
              options.cause === "revalidate" && "key" in prior ? prior.key : null;
            options.signal.addEventListener(
              "abort",
              () =>
                record("route.aborted", () => ({
                  ...facts,
                  reason: reason(options.signal.reason),
                  source: new Error().stack,
                })),
              { once: true },
            );
            return { ...facts, prior };
          });
          const rejected = (error: unknown) =>
            record("route.admission", () => ({
              ...facts,
              decision: "rejected",
              reason: reason(error),
            }));
          const accepted = (value: unknown) =>
            record("route.admission", () => {
              const result = data(value);
              return {
                ...facts,
                result,
                decision:
                  options.signal.aborted || result.kind !== "session" ? "rejected" : "accepted",
                reason: options.signal.aborted
                  ? "aborted"
                  : (("cache" in result ? result.cache : undefined) ??
                    result.kind ??
                    "redirect-or-not-found"),
              };
            });
          try {
            const result: unknown = Reflect.apply(target, receiver, args);
            if (result instanceof Promise) {
              void result.then(accepted, rejected);
            } else {
              accepted(result);
            }
            return result;
          } catch (error) {
            rejected(error);
            throw error;
          }
        },
      });
    }
    let previous = "";
    router.subscribe((state) =>
      record("route.published", () => {
        const matches = [...state.matches, ...state.pendingMatches].map((match) => ({
          pending: state.pendingMatches.includes(match),
          pathname: match.location.pathname,
          status: match.status,
          fetching: match.isFetching,
          aborted: match.abortController.signal.aborted,
          data: data(match.data),
        }));
        const serialized = JSON.stringify(matches);
        if (serialized === previous) {
          return undefined;
        }
        previous = serialized;
        return { matches };
      }),
    );
    record("observer.attached", () => ({}));
  };
  document.addEventListener(
    "context-provider",
    (event) => {
      const incoming = event as ApplicationContextRequest;
      if (incoming.context !== "openclaw.application" || !(event.target instanceof HTMLElement)) {
        return;
      }
      event.target.dispatchEvent(
        Object.assign(new Event("context-request", { bubbles: true }), {
          context: incoming.context,
          contextTarget: document.documentElement,
          callback: (context: ApplicationContext) => {
            try {
              attach(context);
            } catch (error) {
              record("observer.error", () => ({ reason: reason(error) }));
            }
          },
        }),
      );
    },
    true,
  );
}

async function openCachedRoute(page: Page) {
  const gateway = await installMockGateway(
    page,
    {
      subscriptionInitialHistory: false,
      sessionKey,
      authMethod: "trusted-proxy",
      authMode: "trusted-proxy",
      sessions: [],
      heldMethods: ["sessions.resolve", "chat.startup", "chat.send"],
      sessionTranscripts: {
        [sessionKey]: { messages: [{ role: "assistant", content: transcript }] },
      },
      methodResponses: {
        "sessions.describe": { session: row },
        "sessions.resolve": { ok: true, ...row },
      },
    },
    {
      afterInitScript: `;(${captureSnapshotRouteEvidence.toString()})(${JSON.stringify(INTERNAL_SESSION_PATH_PARAM)});`,
    },
  );
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  await gateway.waitForRequest("chat.startup");
  await gateway.resolveDeferred("chat.startup");
  await page.getByText(transcript, { exact: true }).waitFor();
  await page.waitForFunction(() =>
    Object.keys(localStorage).some((key) => key.startsWith("openclaw.control.bootRecord.v1:")),
  );
  await page.evaluate(async () => {
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    await Reflect.get(pane!, "sessionSnapshotStore").flush();
  });
  return gateway;
}

suite.define(() => {
  it("retains admission and reply evidence in the existing browser event ring", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const events = installControlUiE2ePageDiagnosticRing(page);
        const gateway = await openCachedRoute(page);
        await page.goto(new URL(`/chat/main/${id.replaceAll("-", "")}`, suite.server.baseUrl).href);
        await page.getByText(transcript, { exact: true }).waitFor();
        await gateway.waitForRequest("sessions.resolve");
        await gateway.waitForRequest("chat.startup");
        await gateway.setMethodResponse("sessions.resolve", { ok: false });
        await gateway.resolveDeferred("sessions.resolve", { ok: false });
        await page.locator(".session-route-not-found").waitFor();
        const [resolution] = await gateway.getRequests("sessions.resolve");
        const params = resolution!.params as SessionsResolveParams;
        // Exercise the native history seam without changing the route or issuing another RPC.
        await page.evaluate(() => history.replaceState(history.state, "", location.href));
        const texts = events.flatMap(({ source, details }) =>
          source === "console" &&
          typeof details.text === "string" &&
          details.text.startsWith("[snapshot-route] ")
            ? [details.text]
            : [],
        );
        const facts = texts.map(
          (text) => JSON.parse(text.slice("[snapshot-route] ".length)) as Record<string, unknown>,
        );
        const evidence = (name: string, fields: object = {}) =>
          expect.objectContaining({
            event: name,
            at: expect.any(Number),
            document: expect.any(Number),
            ...fields,
          });
        expect(facts).toEqual(
          expect.arrayContaining([
            evidence("route.requested", {
              cause: "navigation",
              reference: `/chat/main/${id.replaceAll("-", "")}`,
              requestedKey: null,
            }),
            evidence("route.admission", { decision: "accepted" }),
            evidence("route.admission", { decision: "rejected", reason: expect.any(String) }),
            ...["sessions.describe", "chat.startup"].map((method) =>
              evidence("rpc.settled", {
                method,
                key: sessionKey,
                id: expect.any(String),
                ok: expect.any(Boolean),
              }),
            ),
            evidence("rpc.settled", {
              method: "sessions.resolve",
              key: params.reference?.key ?? params.key ?? null,
              id: resolution!.id,
              ok: expect.any(Boolean),
            }),
            evidence("mock.reply.dispatched", {
              method: "sessions.resolve",
              id: resolution!.id,
              ok: true,
              reply: { key: null, agentId: null },
            }),
            evidence("mock.release", { method: "sessions.resolve" }),
            evidence("history.replaceState", { source: expect.any(String) }),
          ]),
        );
        for (const fact of facts.filter(
          (entry) => entry.event === "rpc.settled" && entry.ok === false,
        )) {
          expect(fact.reason).toEqual(expect.any(String));
        }
        expect(JSON.stringify(facts)).not.toContain(transcript);
      },
    );
  });

  it("keeps live metadata actions available while only message delivery waits for confirmation", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await openCachedRoute(page);
        await page.goto(new URL(`/chat/main/${id}`, suite.server.baseUrl).href);
        await page.getByText(transcript, { exact: true }).waitFor();
        await gateway.waitForRequest("sessions.resolve");
        await gateway.waitForRequest("chat.startup");
        await gateway.resolveDeferred("chat.startup", {
          messages: [{ role: "assistant", content: transcript }],
          sessionInfo: { ...row, unread: true, sharingRole: "owner" },
        });
        const pane = page.locator(".chat-pane-cache__pane--active");
        await pane
          .getByText("Snapshot conversation", { exact: true })
          .filter({ visible: true })
          .first()
          .waitFor();
        await pane.locator(".chat-header-session-menu__trigger").click();
        const rename = page.getByRole("menuitem", { name: "Rename…", exact: true });
        expect(await rename.isEnabled()).toBe(true);
        await rename.click();
        const name = pane.locator(".chat-pane__session-title-input");
        await name.fill("Renamed from live metadata");
        await name.press("Enter");
        const patch = await gateway.waitForRequest("sessions.patch");
        expect(patch.params).toMatchObject({
          key: sessionKey,
          expectedSessionId: row.sessionId,
          label: "Renamed from live metadata",
        });
        expect(await pane.locator(".chat-send-btn--send").isDisabled()).toBe(true);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await gateway.resolveDeferred("sessions.resolve", { ok: true, ...row });
        await page.waitForFunction(() => window.openclawControlUi?.snapshot().routeReady === true);
        await pane.locator(".chat-header-session-menu__trigger").click();
        expect(await rename.isEnabled()).toBe(true);
      },
    );
  });

  it("rejects stale route confirmation across reconnect while cached rows are admitted", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await openCachedRoute(page);
        await page.goto(new URL(`/chat/main/${id}`, suite.server.baseUrl).href);
        await page.getByText(transcript, { exact: true }).waitFor();
        await gateway.waitForRequest("sessions.resolve");
        const composer = page.locator(
          ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
        );
        await composer.fill("Keep this draft across route admission reconnect");
        const connects = (await gateway.getRequests("connect")).length;
        await gateway.deferNext("connect");
        await gateway.closeLatest(4000, "synthetic reconnect during route confirmation");
        await gateway.waitForRequest("connect", { after: connects });
        await gateway.resolveDeferred("sessions.resolve", {
          ok: true,
          ...row,
          key: `agent:other:chat:${id}`,
          agentId: "other",
        });
        expect(new URL(page.url()).pathname).toBe(`/chat/main/${id}`);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await gateway.setMethodResponse("sessions.resolve", { ok: true, ...row });
        await gateway.deferNext("sessions.resolve");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("sessions.resolve", { after: 1 });
        await composer.waitFor({ state: "hidden" });
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await gateway.resolveDeferred("sessions.resolve", { ok: true, ...row });
        await gateway.resolveDeferred("chat.startup");
        await page.getByText(transcript, { exact: true }).waitFor();
        await page.waitForFunction(() => window.openclawControlUi?.snapshot().routeReady === true);
        expect(new URL(page.url()).pathname).toMatch(/^\/chat\/main\//);
        expect((await composer.inputValue()).trimEnd()).toBe(
          "Keep this draft across route admission reconnect",
        );
        await composer.press("Enter");
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toMatchObject({
          sessionKey,
          message: "Keep this draft across route admission reconnect",
        });
      },
    );
  });

  it.each(["same", "deleted", "moved"] as const)(
    "holds a restored outbox across reload until %s route confirmation",
    async (outcome) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          const gateway = await openCachedRoute(page);
          await gateway.setOnline(false);
          await page.locator(".agent-chat__input--offline").waitFor();
          const message = "Restore this queued message only after route confirmation";
          await page.locator(".agent-chat__composer-combobox textarea").fill(message);
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await page.locator(".chat-queue").getByText(message, { exact: true }).waitFor();
          const [queued] = await readOutboxQueue(page);
          expect(queued?.sendAttempts).toBe(0);
          await page.goto(new URL(`/chat/main/${id}`, suite.server.baseUrl).href);
          await gateway.setOnline(true);
          await page.getByText(transcript, { exact: true }).waitFor();
          await gateway.waitForRequest("sessions.resolve");
          await gateway.waitForRequest("chat.startup");
          await gateway.resolveDeferred("chat.startup", { messages: [], sessionInfo: row });
          await page.locator(".chat-queue").getByText(message, { exact: true }).waitFor();
          const [restored] = await readOutboxQueue(page);
          expect(restored?.sendRunId).toBe(queued?.sendRunId);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await gateway.setMethodResponse("chat.history", {
            messages: [],
            sessionId: row.sessionId,
            sessionInfo: row,
          });
          const resolution =
            outcome === "deleted"
              ? { ok: false }
              : {
                  ok: true,
                  ...row,
                  ...(outcome === "moved"
                    ? { key: `agent:other:chat:${id}`, agentId: "other" }
                    : {}),
                };
          await gateway.setMethodResponse("sessions.resolve", resolution);
          await gateway.resolveDeferred("sessions.resolve", resolution);
          if (outcome === "same") {
            await page.waitForFunction(
              () => window.openclawControlUi?.snapshot().routeReady === true,
            );
            const sent = await gateway.waitForRequest("chat.send");
            expect(sent.params).toMatchObject({
              sessionKey,
              message,
              idempotencyKey: queued?.sendRunId,
            });
            expect(await gateway.getRequests("chat.send")).toHaveLength(1);
          } else {
            if (outcome === "deleted") {
              await page.locator(".session-route-not-found").waitFor();
            } else {
              await page.waitForURL((url) => url.pathname.startsWith("/chat/other/"));
            }
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          }
        },
      );
    },
  );

  it.each(["same", "deleted", "moved", "mismatch"] as const)(
    "renders off-roster cached rows before resolve and reconciles %s authority",
    async (outcome) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          const gateway = await openCachedRoute(page);
          const reference = outcome === "same" ? id : id.replaceAll("-", "");
          await page.goto(new URL(`/chat/main/${reference}`, suite.server.baseUrl).href);
          await page.getByText(transcript, { exact: true }).waitFor();
          await gateway.waitForRequest("sessions.resolve");
          await gateway.waitForRequest("chat.startup");
          if (captureUiProof) {
            await page.screenshot({ path: path.join(suite.artifactDir, `cached-${outcome}.png`) });
          }
          const movedKey =
            outcome === "mismatch"
              ? "agent:main:chat:98765432-1234-4321-9876-123456789abc"
              : `agent:other:chat:${id}`;
          const movedAgent = outcome === "mismatch" ? "main" : "other";
          if (outcome === "moved" || outcome === "mismatch") {
            await gateway.setMethodResponse("sessions.describe", {
              session: { ...row, key: movedKey, agentId: movedAgent },
            });
          }
          const resolution =
            outcome === "deleted"
              ? { ok: false }
              : {
                  ok: true,
                  ...row,
                  ...(outcome === "moved" || outcome === "mismatch"
                    ? { key: movedKey, agentId: movedAgent }
                    : {}),
                };
          await gateway.setMethodResponse("sessions.resolve", resolution);
          await gateway.resolveDeferred("sessions.resolve", resolution);
          if (outcome === "deleted") {
            await page.locator(".session-route-not-found").waitFor();
            expect(await page.getByText(transcript, { exact: true }).count()).toBe(0);
          } else if (outcome === "moved" || outcome === "mismatch") {
            const targetPath = pathForSession(
              "chat",
              movedAgent,
              movedKey,
              new URL(suite.server.baseUrl).pathname,
              { displayName: row.displayName },
            );
            await page.waitForURL((url) => url.pathname === targetPath);
            // Parked route presentations retain selected panes until their owner retires.
            const paneSelector = '.chat-pane-cache__pane--active[aria-hidden="false"]:not([inert])';
            await page.waitForFunction(
              ({ key, selector }) =>
                [...document.querySelectorAll(selector)].some(
                  (pane) =>
                    pane.checkVisibility({ visibilityProperty: true }) &&
                    Reflect.get(pane, "sessionKey") === key,
                ),
              { key: movedKey, selector: paneSelector },
            );
            await page
              .locator(paneSelector)
              .filter({ visible: true })
              .getByText(transcript, { exact: true })
              .waitFor({ state: "hidden" });
          } else {
            await gateway.resolveDeferred("chat.startup");
            await page.getByText(transcript, { exact: true }).waitFor();
            await page.waitForFunction(
              () => window.openclawControlUi?.snapshot().routeReady === true,
            );
            expect(await gateway.getRequests("sessions.resolve")).toHaveLength(1);
          }
        },
      );
    },
  );

  it("holds an early Enter until route authority settles, then sends it once", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await openCachedRoute(page);
        await page.goto(new URL(`/chat/main/${id}`, suite.server.baseUrl).href);
        await page.getByText(transcript, { exact: true }).waitFor();
        await gateway.waitForRequest("sessions.resolve");
        await gateway.waitForRequest("chat.startup");
        await gateway.resolveDeferred("chat.startup", { messages: [] });
        const pane = page.locator(".chat-pane-cache__pane--active");
        await page.waitForFunction(() => {
          const active = document.querySelector(".chat-pane-cache__pane--active");
          return active && Reflect.get(active, "transcriptReady") === true;
        });
        const draft = "Keep this draft until the route is confirmed";
        await pane.locator(".agent-chat__composer-combobox textarea").fill(draft);
        const send = pane.locator(".chat-send-btn--send");
        expect(await send.isDisabled()).toBe(true);
        const composer = pane.locator(".agent-chat__composer-combobox textarea");
        await composer.press("Enter");
        expect(await composer.inputValue()).toBe(draft);
        expect(await pane.locator(".agent-chat__input--submit-queued").count()).toBe(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        const resolution = { ok: true, ...row };
        await gateway.setMethodResponse("sessions.resolve", resolution);
        await gateway.resolveDeferred("sessions.resolve", resolution);
        await page.waitForFunction(() => window.openclawControlUi?.snapshot().routeReady === true);
        expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
          message: draft,
        });
        await expect.poll(() => composer.inputValue()).toBe("");
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });
});
