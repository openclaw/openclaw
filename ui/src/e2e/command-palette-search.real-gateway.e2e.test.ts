import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiDocument } from "../../../src/commands/control-ui-handoff.ts";
import {
  appendTranscriptMessages,
  createSessionEntryWithTranscript,
} from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import { captureEnv, setTestEnvValue } from "../../../src/test-utils/env.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { COMMUNITY_INVITE_KEY } from "../components/community-invite-state.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const requireRecord = createRequireRecord("record", "expected-object-value");
const agentIds = ["main", "second", "third", "fourth", "fifth"];
const recentSessionCount = 205;
const commonMatchCount = 30;
const commonQuery = "orchardglow";
const uniqueQuery = "copperfinch";
const targetKey = "agent:fifth:search-proof-12345678-0000-4000-8000-000000000001";
const targetLabel = "Older fifth-agent conversation";
const targetMessage =
  "The copperfinch observatory has a violet lantern beside the northern window.";
const scope = {
  includeGlobal: false,
  includeUnknown: false,
  configuredAgentsOnly: true,
  excludeSubagents: true,
  excludeCron: true,
  excludeSystem: true,
};
const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let instance: OpenClawTestInstance | undefined;

type RpcObservation = {
  method: string;
  params: Record<string, unknown>;
  startedMs: number;
  elapsedMs?: number;
  ok?: boolean;
  responseBytes?: number;
  resultCount?: number;
  resultKeys?: unknown[];
  sessionKeys?: unknown[];
  truncated?: boolean;
  indexing?: boolean;
  archivedTranscriptsExcluded?: number;
};

type QueryObservation = {
  query: string;
  elapsedMs: number;
  visibleResults: number;
  searchRequests: number;
  metadataRequests: number;
  backgroundListRequests: number;
  notices: string[];
};

async function seedSessions(owner: OpenClawTestInstance, config: OpenClawConfig) {
  const profile = ensureGatewayOwnerProfile("Synthetic Search Viewer", { env: owner.env });
  const now = Date.now();
  const recent = Array.from({ length: recentSessionCount }, (_, index) => ({
    agentId: agentIds[index % agentIds.length]!,
    key: `agent:${agentIds[index % agentIds.length]}:search-roster-${index}`,
    label: `Synthetic conversation ${index + 1}`,
    updatedAt: now - index * 1000,
    text:
      index < commonMatchCount
        ? `The ${commonQuery} sample is recorded for this conversation.`
        : null,
  }));
  const fixtures = [
    ...recent,
    {
      agentId: "fifth",
      key: targetKey,
      label: targetLabel,
      updatedAt: now - 7 * 86_400_000,
      text: targetMessage,
    },
  ];
  // Prepare canonical SQLite entries and synchronously indexed message appends
  // before the child starts, so its resident projection sees the complete corpus.
  for (const fixture of fixtures) {
    const sessionId = randomUUID();
    const target = { agentId: fixture.agentId, sessionKey: fixture.key, env: owner.env };
    const created = await createSessionEntryWithTranscript(
      target,
      () => ({
        ok: true,
        entry: {
          sessionId,
          updatedAt: fixture.updatedAt,
          label: fixture.label,
          visibility: "shared",
          ...(fixture.key === targetKey
            ? {
                category: "HOME ASSISTANT",
                spawnedBy: "agent:main:search-roster-0",
                parentSessionKey: "agent:main:search-roster-0",
                createdVia: "spawn" as const,
                createdActor: { type: "agent" as const, id: "main" },
              }
            : {
                createdActor: {
                  type: "human" as const,
                  source: "profile" as const,
                  id: profile.id,
                },
              }),
        },
      }),
      { cwd: owner.state.workspaceDir },
    );
    expect(created.ok, "canonical fixture session creation").toBe(true);
    if (fixture.text) {
      const appended = await appendTranscriptMessages(
        { ...target, sessionId },
        {
          config,
          cwd: owner.state.workspaceDir,
          messages: [
            {
              message: {
                role: "user",
                content: [{ type: "text", text: fixture.text }],
                timestamp: fixture.updatedAt,
              },
              now: fixture.updatedAt,
            },
          ],
        },
      );
      expect(appended).toHaveLength(1);
    }
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI command palette search with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "command-palette-search",
      // Normal startup publishes the real catalog used by the palette. The
      // instance still isolates HOME/state and suppresses external transports.
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
    });
    instance = owner;
    const proxyEnv = captureEnv(["NO_PROXY", "no_proxy"]);
    // Node's env-proxy fetch also applies to the parent readiness probe. Exempt
    // only this fixture's claimed loopback port, keeping external proxy routing
    // and existing exclusions intact in both the fork and its Gateway/CLI child.
    const noProxy = [
      process.env.NO_PROXY,
      process.env.no_proxy,
      `127.0.0.1:${owner.port}`,
      `localhost:${owner.port}`,
    ]
      .filter(Boolean)
      .join(",");
    for (const key of ["NO_PROXY", "no_proxy"]) {
      setTestEnvValue(key, noProxy);
      owner.env[key] = noProxy;
    }
    try {
      await mkdir(owner.state.workspaceDir, { recursive: true });
      const config: OpenClawConfig = {
        gateway: {
          port: owner.port,
          auth: { mode: "token", token: owner.gatewayToken },
          controlUi: { enabled: true },
        },
        cron: { enabled: false },
        // Core search proof must not depend on external plugin catalog refreshes.
        plugins: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: owner.state.workspaceDir,
            model: "fixture/search-model",
            modelPolicy: { allow: ["fixture/*"] },
            heartbeat: { every: "0m" },
          },
          entries: Object.fromEntries(
            agentIds.map((id) => [id, { identity: { name: `Synthetic ${id} assistant` } }]),
          ),
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-no-inference-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                {
                  id: "search-model",
                  name: "Synthetic search model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
      };
      await owner.state.writeConfig(config);
      await seedSessions(owner, config);
      await owner.startGateway();
      return {
        baseUrl: `http://127.0.0.1:${owner.port}/`,
        close: () =>
          runQaGatewayFixture(
            () => owner.cleanup(),
            () => proxyEnv.restore(),
          ),
      };
    } catch (error) {
      const diagnostics = path.join(suite.artifactDir, "gateway-setup.log");
      const sanitized = (String(error) + "\n" + owner.logs())
        .replaceAll(owner.gatewayToken, "[redacted fixture token]")
        .replaceAll(owner.hookToken, "[redacted fixture token]");
      const failure = new Error(`Gateway setup failed; sanitized diagnostics: ${diagnostics}`);
      return await runQaGatewayFixture(
        async (): Promise<never> => {
          await writeFile(diagnostics, sanitized);
          // Keep all safe probe receipts, not only the last near-deadline attempt.
          await writeFile(
            path.join(suite.artifactDir, "gateway-readiness.json"),
            JSON.stringify(
              owner.readiness.map(({ logs: _logs, ...receipt }) => receipt),
              null,
              2,
            ),
          );
          throw failure;
        },
        () => owner.cleanup(),
        () => proxyEnv.restore(),
      );
    }
  },
});

function observeSearchTraffic(page: Page, rpc: RpcObservation[]) {
  page.on("websocket", (socket) => {
    const pending = new Map<string, RpcObservation>();
    socket.on("framesent", ({ payload }) => {
      const frame = requireRecord(JSON.parse(payload.toString()));
      if (
        frame.type !== "req" ||
        typeof frame.id !== "string" ||
        typeof frame.method !== "string"
      ) {
        return;
      }
      // Never retain connect/auth frames or unrelated RPC payloads.
      if (
        ![
          "sessions.search",
          "sessions.list",
          "sessions.create",
          "sessions.patch",
          "chat.send",
          "agent",
        ].includes(frame.method)
      ) {
        return;
      }
      const metric: RpcObservation = {
        method: frame.method,
        params: frame.method.startsWith("sessions.") ? requireRecord(frame.params) : {},
        startedMs: performance.now(),
      };
      rpc.push(metric);
      pending.set(frame.id, metric);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = requireRecord(JSON.parse(payload.toString()));
      const metric =
        frame.type === "res" && typeof frame.id === "string" ? pending.get(frame.id) : undefined;
      if (!metric) {
        return;
      }
      metric.elapsedMs = performance.now() - metric.startedMs;
      metric.ok = frame.ok === true;
      metric.responseBytes = Buffer.byteLength(payload);
      const body = isRecord(frame.payload) ? frame.payload : {};
      if (Array.isArray(body.results)) {
        metric.resultCount = body.results.length;
        metric.resultKeys = body.results.map((hit) => (isRecord(hit) ? hit.sessionKey : null));
      }
      if (Array.isArray(body.sessions)) {
        metric.sessionKeys = body.sessions.map((row) => (isRecord(row) ? row.key : null));
      }
      metric.truncated = body.truncated === true;
      metric.indexing = body.indexing === true;
      metric.archivedTranscriptsExcluded =
        typeof body.archivedTranscriptsExcluded === "number" ? body.archivedTranscriptsExcluded : 0;
      if (typeof frame.id === "string") {
        pending.delete(frame.id);
      }
    });
    socket.on("close", () => pending.clear());
  });
}

suite.define(() => {
  it("finds a grouped spawned conversation beyond the roster and treats a full result page as success", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const rpc: RpcObservation[] = [];
    const queries: QueryObservation[] = [];
    const assets: Array<{ path: string; servedSha256: string; builtSha256: string }> = [];
    const screenshots: string[] = [];
    let passed = false;
    const artifactDir = suite.artifactDir;
    try {
      // Gateway readiness precedes background UI preparation. The JSON handoff
      // deliberately fails fast, so await its document prerequisite here.
      const uiDocument = await waitForControlUiDocument({
        url: suite.server.baseUrl,
        timeoutMs: 60_000,
        onPending: () => console.log("[search-proof] waiting for the preparing UI document"),
      });
      expect(uiDocument.ready, uiDocument.ready ? "ready" : uiDocument.reason).toBe(true);
      const handoff = await owner.cli(["dashboard", "--json"]);
      const result = requireRecord(JSON.parse(handoff.stdout));
      expect(
        handoff.code,
        typeof result.reason === "string" ? result.reason : "isolated dashboard handoff",
      ).toBe(0);
      const browserUrl = result.browserUrl;
      if (typeof browserUrl !== "string") {
        throw new Error("Dashboard did not return a browser handoff");
      }
      const url = new URL("/chat/main", suite.server.baseUrl);
      url.hash = new URL(browserUrl).hash;
      await suite.withPage(
        { serviceWorkers: "block", locale: "en-US", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          await page.addInitScript((key) => {
            localStorage.setItem(key, JSON.stringify({ dismissedAtMs: 1770000000000 }));
          }, COMMUNITY_INVITE_KEY);
          observeSearchTraffic(page, rpc);
          expect((await page.goto(url.href))?.status()).toBe(200);
          await waitForControlUiGatewayReady(page);
          await page.locator(".shell").waitFor({ state: "visible" });
          await expect
            .poll(() =>
              rpc.some(
                (metric) => metric.method === "sessions.list" && metric.elapsedMs !== undefined,
              ),
            )
            .toBe(true);
          await expect.poll(() => rpc.every((metric) => metric.elapsedMs !== undefined)).toBe(true);

          // Bind proof to the actual served production entry, not a Vite source
          // server or an unrelated operator Gateway with stale UI bytes.
          const scripts = await page
            .locator('script[type="module"][src]')
            .evaluateAll((elements) =>
              elements.map((element) => new URL((element as HTMLScriptElement).src).pathname),
            );
          expect(scripts.some((script) => /\/assets\/index-[^/]+\.js$/u.test(script))).toBe(true);
          for (const script of scripts) {
            expect(script).toMatch(/^\/assets\/[^/]+\.js$/u);
            const served = await page.request.get(new URL(script, suite.server.baseUrl).href);
            expect(served.status()).toBe(200);
            const built = await readFile(
              path.join(process.cwd(), "dist/control-ui", script.slice(1)),
            );
            const servedSha256 = createHash("sha256")
              .update(await served.body())
              .digest("hex");
            const builtSha256 = createHash("sha256").update(built).digest("hex");
            assets.push({ path: script, servedSha256, builtSha256 });
            expect(servedSha256).toBe(builtSha256);
          }
          const capture = async (filename: string, surface: Locator, content: Locator[]) => {
            if (captureEnabled) {
              await writeFile(
                path.join(artifactDir, filename),
                await takeControlUiViewportScreenshot(page, surface, content),
              );
              screenshots.push(filename);
            }
          };
          await page.keyboard.press("ControlOrMeta+K");
          const palette = page.locator(".cmd-palette");
          const input = palette.getByRole("textbox", {
            name: "Search or start a task…",
            exact: true,
          });
          const results = palette.locator(".cmd-palette__results");
          const emptyState = palette.locator(".cmd-palette__no-results");
          await input.waitFor();
          const search = async (
            query: string,
            expectedHits: number,
            filename: string,
            metadataKeys: string[] = [],
          ) => {
            const noMatches = expectedHits === 0 && metadataKeys.length === 0;
            const start = rpc.length;
            const started = performance.now();
            await input.fill(query);
            await expect
              .poll(
                () => rpc.slice(start).filter((entry) => entry.method === "sessions.search").length,
              )
              .toBeGreaterThan(0);
            await expect
              .poll(() => rpc.slice(start).every((entry) => entry.elapsedMs !== undefined))
              .toBe(true);
            await expect.poll(() => results.getAttribute("aria-busy")).toBe("false");
            const notices = await palette
              .locator(".cmd-palette__search")
              .getByRole("status")
              .allTextContents();
            const traffic = rpc.slice(start);
            const searches = traffic.filter((entry) => entry.method === "sessions.search");
            // The sidebar can fetch lineage concurrently; identify this query
            // by its metadata-search intent, not by arrival time alone.
            const listRequests = traffic.filter((entry) => entry.method === "sessions.list");
            const metadata = listRequests.filter((entry) => entry.params.search === query);
            const visibleResults = await results.getByRole("option").count();
            queries.push({
              query,
              elapsedMs: performance.now() - started,
              visibleResults,
              searchRequests: searches.length,
              metadataRequests: metadata.length,
              backgroundListRequests: listRequests.length - metadata.length,
              notices,
            });
            // Capture the settled state before assertions too, retaining useful
            // before-fix evidence when run against the original regression.
            await capture(filename, palette, [input, visibleResults === 0 ? emptyState : results]);
            expect(searches).toHaveLength(1);
            const response = searches[0]!;
            expect(response.params).toEqual({ query, limit: 25, scope });
            expect(response.ok).toBe(true);
            expect(response.resultCount).toBe(expectedHits);
            expect(response.indexing).toBe(false);
            expect(response.archivedTranscriptsExcluded).toBe(0);
            expect(response.sessionKeys?.length).toBeLessThanOrEqual(25);
            expect(new Set(response.sessionKeys)).toEqual(new Set(response.resultKeys));
            // The query owns one bounded metadata lookup. The scoped transcript
            // request above cannot be limited by any background roster window.
            expect(metadata).toHaveLength(1);
            expect(metadata[0]?.params).toEqual({ ...scope, search: query, limit: 10 });
            expect(metadata[0]?.ok).toBe(true);
            expect(metadata[0]?.sessionKeys).toEqual(metadataKeys);
            expect(notices).toEqual(noMatches ? [expect.stringContaining("No results found")] : []);
            expect(
              await palette
                .getByText(/Search notices|incomplete|unavailable|indexing older/i)
                .count(),
            ).toBe(0);
            return response;
          };

          const common = await search(commonQuery, 25, "01-common-limited-search.png");
          expect(common.truncated).toBe(true);
          await expect.poll(() => results.getByRole("option").count()).toBe(10);
          expect(
            common.resultKeys?.every(
              (key) => typeof key === "string" && key.includes(":search-roster-"),
            ),
          ).toBe(true);

          await search(targetLabel, 0, "02-grouped-metadata-match.png", [targetKey]);
          await results.getByRole("option").filter({ hasText: targetLabel }).click();
          await input.waitFor({ state: "hidden" });
          const activePane = () =>
            page.locator("openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])");
          await expect
            .poll(() =>
              activePane().evaluate(
                (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
              ),
            )
            .toBe(targetKey);
          await activePane()
            .locator(".chat-thread")
            .getByText(targetMessage, { exact: true })
            .waitFor();
          await page.goBack();
          await expect
            .poll(() =>
              activePane().evaluate(
                (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
              ),
            )
            .toBe("agent:main:main");
          await page.keyboard.press("ControlOrMeta+K");
          await input.waitFor();

          const unique = await search(uniqueQuery, 1, "02-older-fifth-agent-match.png");
          expect(unique.resultKeys).toEqual([targetKey]);
          expect(unique.truncated).toBe(false);
          await results.getByRole("option").filter({ hasText: targetLabel }).waitFor();
          expect(await results.getByRole("option").count()).toBe(1);
          expect(await results.textContent()).toContain("Synthetic fifth assistant");
          expect(await results.textContent()).toContain(targetMessage);

          const upper = await search(uniqueQuery.toUpperCase(), 1, "03-case-insensitive-match.png");
          expect(upper.resultKeys).toEqual([targetKey]);
          // The public FTS contract ANDs whitespace-separated words; this proves
          // multiword narrowing without inventing quoted exact-phrase semantics.
          const phrase = await search("copperfinch violet lantern", 1, "04-multiword-match.png");
          expect(phrase.resultKeys).toEqual([targetKey]);
          const absent = await search("copperfinch absentconstellation", 0, "05-no-match.png");
          expect(absent.truncated).toBe(false);
          expect(await results.getByRole("option").count()).toBe(0);
          await emptyState
            .getByRole("heading", { name: "No results found", exact: true })
            .waitFor();

          await search("copperfinch observatory", 1, "06-selected-search-result.png");
          await results.getByRole("option").filter({ hasText: targetLabel }).click();
          await input.waitFor({ state: "hidden" });
          const pane = page.locator(
            "openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])",
          );
          await expect
            .poll(() =>
              pane.evaluate(
                (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
              ),
            )
            .toBe(targetKey);
          await pane.locator(".chat-thread").getByText(targetMessage, { exact: true }).waitFor();
          await capture("07-opened-fifth-agent-transcript.png", pane, [
            pane.locator(".chat-thread"),
          ]);

          const otherKey = "agent:fifth:search-roster-4";
          await page
            .locator(
              `.sidebar-recent-session[data-session-key="${otherKey}"] .sidebar-recent-session__link`,
            )
            .click();
          await expect
            .poll(() =>
              activePane().evaluate(
                (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
              ),
            )
            .toBe(otherKey);
          const call = async (method: string, params: Record<string, unknown>) => {
            const rpcResult = await owner.cli([
              "gateway",
              "call",
              method,
              "--json",
              "--params",
              JSON.stringify(params),
            ]);
            expect(rpcResult.code, rpcResult.stderr).toBe(0);
            return requireRecord(JSON.parse(rpcResult.stdout));
          };
          for (const category of ["Research", null, "HOME ASSISTANT"]) {
            await call("sessions.patch", { key: targetKey, category });
            const groupRows = page.locator(
              `[data-session-section^="category:"] [data-session-key="${targetKey}"]`,
            );
            await expect.poll(() => groupRows.count()).toBe(category ? 1 : 0);
            if (category) {
              await page
                .locator(
                  `[data-session-section="category:${category}"] [data-session-key="${targetKey}"]`,
                )
                .waitFor({ state: "visible" });
            }
            const inventory = await call("sessions.list", {
              ...scope,
              search: targetLabel,
              includePeople: true,
            });
            expect(inventory).toMatchObject({
              totalCount: category ? 1 : 0,
              peopleSessionCount: category ? 1 : 0,
            });
            expect(inventory.owners).toHaveLength(category ? 1 : 0);
            await page.keyboard.press("ControlOrMeta+K");
            await input.waitFor();
            const stage = category?.replaceAll(" ", "-") ?? "ungrouped";
            await search(
              targetLabel,
              0,
              `category-${stage}-metadata.png`,
              category ? [targetKey] : [],
            );
            await search(uniqueQuery, category ? 1 : 0, `category-${stage}-transcript.png`);
            await page.keyboard.press("Escape");
            await input.waitFor({ state: "hidden" });
          }
          expect(rpc.filter((metric) => metric.method === "sessions.search")).toHaveLength(
            queries.length,
          );
          expect(
            rpc.filter((metric) => metric.method === "chat.send" || metric.method === "agent"),
          ).toEqual([]);
          // Cover the agreed direct shortcuts against the same isolated real Gateway.
          // The existing capture gate exports these sanitized views on manual proof runs.
          const currentPane = activePane();
          await capture("direct-01-before.png", currentPane, [currentPane.locator(".chat-thread")]);
          await page.keyboard.press("ControlOrMeta+/");
          const helper = page.locator("openclaw-keyboard-shortcuts-dialog");
          const newHint = helper.locator(".shortcut-row").filter({ hasText: "Open New Session" });
          const archiveHint = helper
            .locator(".shortcut-row")
            .filter({ hasText: "Archive current session" });
          await newHint.waitFor({ state: "visible" });
          await archiveHint.waitFor({ state: "visible" });
          expect((await newHint.locator("kbd").allTextContents()).at(-1)).toBe("O");
          expect((await archiveHint.locator("kbd").allTextContents()).at(-1)).toBe("A");
          // The host is display: contents; the native dialog owns the opening animation.
          await capture("direct-02-keyboard-helper.png", helper.locator("dialog"), [
            newHint,
            archiveHint,
          ]);
          await page.keyboard.press("Escape");
          await newHint.waitFor({ state: "hidden" });
          await page.keyboard.press("ControlOrMeta+Shift+O");
          const draft = page.locator("openclaw-new-session-page .new-session-page__message");
          await draft.waitFor({ state: "visible" });
          await expect
            .poll(() => draft.evaluate((element) => element === document.activeElement))
            .toBe(true);
          expect(await draft.inputValue()).toBe("");
          await capture("direct-03-new-session.png", page.locator("openclaw-new-session-page"), [
            draft,
          ]);
          await page.goBack();
          await expect
            .poll(() =>
              currentPane.evaluate(
                (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
              ),
            )
            .toBe(otherKey);
          const composer = currentPane.locator(".agent-chat__composer-combobox > textarea");
          await composer.fill("Keep this unsent shortcut draft");
          await capture("direct-04-archive-before.png", currentPane, [composer]);
          await page.keyboard.press("ControlOrMeta+Shift+A");
          const archiveRequests = (archived: boolean) =>
            rpc.filter(
              (metric) =>
                metric.method === "sessions.patch" &&
                metric.params.key === otherKey &&
                metric.params.archived === archived,
            );
          await expect
            .poll(() => archiveRequests(true).filter((metric) => metric.ok === true).length)
            .toBe(1);
          const undo = page.getByRole("button", { name: "Undo", exact: true });
          await undo.waitFor({ state: "visible" });
          await capture("direct-05-archive-after.png", currentPane, [
            currentPane.locator(".chat-thread"),
          ]);
          await undo.click();
          await expect
            .poll(() => archiveRequests(false).filter((metric) => metric.ok === true).length)
            .toBe(1);
          await expect.poll(() => composer.inputValue()).toBe("Keep this unsent shortcut draft");
          expect(
            rpc.filter((metric) =>
              ["sessions.create", "chat.send", "agent"].includes(metric.method),
            ),
          ).toEqual([]);
        },
      );
      passed = true;
    } finally {
      if (!passed) {
        await writeFile(
          path.join(artifactDir, "gateway-failure.log"),
          owner
            .logs()
            .replaceAll(owner.gatewayToken, "[redacted fixture token]")
            .replaceAll(owner.hookToken, "[redacted fixture token]"),
        );
      }
      await writeFile(
        path.join(artifactDir, "search-proof.json"),
        JSON.stringify(
          {
            passed,
            fixture: {
              sessions: recentSessionCount + 1,
              configuredAgents: agentIds.length,
              newerSessions: recentSessionCount,
              commonMatches: commonMatchCount,
              targetKey,
            },
            assets,
            queries,
            rpc,
            screenshots,
          },
          null,
          2,
        ),
      );
    }
  });
});
