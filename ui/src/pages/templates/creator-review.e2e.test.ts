import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Browser, type Page } from "playwright";
import { expect, it } from "vitest";
import type { OpenClawTestInstance } from "../../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../../test/helpers/qa-gateway-cleanup.ts";
import { startScrollInferenceFixture } from "../../e2e/chat-collaborator-scroll.real-gateway.test-support.ts";
import { assertServedUi, pairFixture } from "../../e2e/chat-lifecycle.test-support.ts";
import {
  connectChatGateway,
  createChatGatewayInstance,
} from "../../e2e/chat-real-gateway.test-support.ts";
import { createDarkDesktopControlUiContextOptions } from "../../e2e/control-ui-browser-options.test-support.ts";
import { seedSidebarSettings } from "../../e2e/sidebar-contract.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { getControlUiContextHandle } from "../../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  reconnectMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
async function withHeldCreator(
  run: (fixture: {
    page: Page;
    gateway: Awaited<ReturnType<typeof installMockGateway>>;
    imports: string[];
    openAction: () => Promise<void>;
    releaseAndSettle: () => Promise<void>;
  }) => Promise<void>,
) {
  const server = await startControlUiE2eServer();
  const release = Promise.withResolvers<void>();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath });
    const page = await browser.newPage(createDarkDesktopControlUiContextOptions());
    await seedSidebarSettings(page, server.baseUrl, { sidebarAgentsMode: "roster" });
    const config = { gateway: { controlUi: { experimental: { templates: true } } } };
    const scope = { input: "Repository", job: "Summarize", output: "Brief", authority: "Read" };
    const gateway = await installMockGateway(page, {
      assistantName: "Harbor",
      featureMethods: [
        "chat.send",
        "templates.drafts.create",
        "templates.drafts.read",
        "templates.drafts.review",
      ],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          hash: "creator-first-use",
          valid: true,
          issues: [],
        },
        "templates.drafts.create": {
          draftId: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087",
          prompt: "Create a shareable Template",
        },
        "templates.drafts.read": { revision: "a".repeat(64), content: JSON.stringify({ scope }) },
        "templates.drafts.review": {
          revision: "a".repeat(64),
          reviewToken: "b".repeat(64),
          publisher: "maker",
          name: "@maker/first-use",
          displayName: "First use",
          version: "0.1.0",
          description: "First-use Template",
          items: [],
          files: [],
          scope,
        },
      },
    });
    const imports: string[] = [];
    page.on("request", (request) => {
      if (/\/template-creator-runtime-[^/]+\.js$/u.test(new URL(request.url()).pathname)) {
        imports.push(request.url());
      }
    });
    await page.goto(`${server.baseUrl}chat`);
    await waitForControlUiRoute(page, { routeId: "chat" });
    const row = page.locator('.sidebar-agent-roster__row[data-agent-id="main"]');
    const menu = page.getByRole("button", { name: "Options for Harbor" });
    await menu.waitFor({ state: "visible" });
    expect(imports).toEqual([]);
    let held = 0;
    await page.route("**/assets/template-creator-runtime-*.js", async (route) => {
      held += 1;
      await release.promise;
      await route.continue();
    });
    const openAction = async () => {
      await row.hover();
      await menu.click();
      await page.getByRole("menuitem", { name: "Create Template", exact: true }).click();
    };
    await openAction();
    await expect.poll(() => held).toBe(1);
    await run({
      page,
      gateway,
      imports,
      openAction,
      releaseAndSettle: async () => {
        release.resolve();
        const url = imports[0];
        if (!url) {
          throw new Error("The creator runtime request was not observed");
        }
        // Wait for the real module and its admission microtasks before testing
        // absence of writes; a zero count while loading would prove nothing.
        await page.evaluate(
          `import(${JSON.stringify(url)}).then(() => new Promise(resolve => window.setTimeout(resolve, 0)))`,
        );
      },
    });
  } finally {
    release.resolve();
    await browser?.close();
    await server.close();
  }
}

it.skipIf(!canRunPlaywrightChromium(executablePath))(
  "loads the creator on the first sidebar action and keeps duplicate clicks behind one admission",
  async () => {
    await withHeldCreator(async ({ page, gateway, imports, openAction, releaseAndSettle }) => {
      await gateway.deferNext("chat.send");
      await openAction();
      expect(await gateway.getRequests("templates.drafts.create")).toHaveLength(0);
      await releaseAndSettle();
      await gateway.waitForRequest("chat.send");
      const creates = await gateway.getRequests("templates.drafts.create");
      expect(creates).toHaveLength(1);
      expect(creates[0]?.params).toEqual({ agentId: "main" });
      expect(imports).toHaveLength(1);
      const dialog = page.getByRole("dialog", { name: "Review your Template" });
      expect(await dialog.count()).toBe(0);
      await gateway.resolveDeferred("chat.send", { status: "started" });
      await dialog.waitFor({ state: "visible" });
      expect(await dialog.getByLabel("Name").inputValue()).toBe("First use");
      expect(await gateway.getRequests("templates.drafts.create")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      console.log(
        "CREATOR_AUTHORITY_TRACE",
        JSON.stringify({
          case: "allowed",
          transport: "GatewayBrowserClient framing through MockWebSocket.send",
          agentId: "main",
          writes: (await gateway.getRequests())
            .filter(
              (request) =>
                request.method === "templates.drafts.create" || request.method === "chat.send",
            )
            .map((request) => request.method),
        }),
      );
    });
  },
);

it.skipIf(!canRunPlaywrightChromium(executablePath)).each(["replacement", "read-only"] as const)(
  "rejects deferred creator writes after %s authority retirement",
  async (mode) => {
    await withHeldCreator(async ({ page, gateway, releaseAndSettle }) => {
      const application = await getControlUiContextHandle(page);
      const client = await application.evaluateHandle((context) => context.gateway.snapshot.client);
      const revision = await application.evaluate((context) => context.gateway.connectionRevision);
      try {
        if (mode === "replacement") {
          await application.evaluate((context) => context.navigate("connection"));
          await waitForControlUiRoute(page, { routeId: "connection" });
          const connection = page.locator("openclaw-connection-page .settings-section").filter({
            has: page
              .locator(".settings-section__heading")
              .getByText("Connection", { exact: true }),
          });
          await connection.getByLabel("Gateway URL", { exact: true }).fill("ws://127.0.0.1:19998");
          await connection
            .getByRole("button", { name: "Apply and reconnect", exact: true })
            .click();
          await connection.getByText("Connected", { exact: true }).waitFor();
          expect((await gateway.getSocketUrls()).at(-1)).toBe("ws://127.0.0.1:19998");
        } else {
          await gateway.setOperatorScopes(["operator.read"]);
          await reconnectMockGateway(page, gateway);
        }
        const authority = await application.evaluate(
          (context, originalClient) => ({
            sameClient: context.gateway.snapshot.client === originalClient,
            revision: context.gateway.connectionRevision,
            scopes: context.gateway.snapshot.hello?.auth?.scopes,
            phase: context.gateway.snapshot.phase,
          }),
          client,
        );
        expect(authority.phase).toBe("connected");
        expect(authority.sameClient).toBe(mode === "read-only");
        expect(authority.revision).toBe(mode === "read-only" ? revision : revision + 1);
        if (mode === "read-only") {
          expect(authority.scopes).toEqual(["operator.read"]);
        }
        await releaseAndSettle();
        const writes = (await gateway.getRequests())
          .filter(
            (request) =>
              request.method === "templates.drafts.create" || request.method === "chat.send",
          )
          .map((request) => request.method);
        expect(writes).toEqual([]);
        console.log(
          "CREATOR_AUTHORITY_TRACE",
          JSON.stringify({
            case: mode,
            transport: "GatewayBrowserClient framing through MockWebSocket.send",
            sameClient: authority.sameClient,
            revisionDelta: authority.revision - revision,
            scopes: authority.scopes,
            phase: authority.phase,
            writes,
            moduleEvaluated: true,
          }),
        );
      } finally {
        await client.dispose();
        await application.dispose();
      }
    });
  },
);

it.skipIf(!canRunPlaywrightChromium(executablePath))(
  "publishes the reviewed selection after closing a pending publish and retrying its failure",
  async () => {
    const server = await startControlUiE2eServer();
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ executablePath });
      const page = await browser.newPage(createDarkDesktopControlUiContextOptions());
      const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
      const optionalFile = "workspace/checklist.md";
      const scope = { input: "Repository", job: "Summarize", output: "Brief", authority: "Read" };
      const reviewed = {
        revision: "a".repeat(64),
        reviewToken: "b".repeat(64),
        publisher: "maker",
        name: "@maker/release-brief",
        displayName: "Release Brief",
        version: "0.1.0",
        description: "Summarizes releases",
        items: [
          {
            id: `file:${optionalFile}`,
            kind: "file",
            label: optionalFile,
            detail: "Check each date and citation.",
            included: true,
          },
        ],
        files: [
          { path: "CLAW.md", content: "Portable release instructions" },
          { path: optionalFile, content: "Check each date and citation." },
        ],
        scope,
      };
      const config = { gateway: { controlUi: { experimental: { templates: true } } } };
      const gateway = await installMockGateway(page, {
        featureMethods: ["create", "read", "review", "publish"].map(
          (op) => `templates.drafts.${op}`,
        ),
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            hash: "templates-review-config",
            valid: true,
            issues: [],
          },
          "templates.drafts.read": {
            content: JSON.stringify({ name: "release-brief", scope }),
            revision: reviewed.revision,
          },
          "templates.drafts.review": reviewed,
          "templates.drafts.publish": {
            name: reviewed.name,
            version: reviewed.version,
            url: "https://clawhub.ai/maker/templates/release-brief",
            publicationStatus: "pending",
          },
        },
      });
      const setReview = (token: string) =>
        gateway.setMethodResponse("templates.drafts.review", {
          ...reviewed,
          reviewToken: token.repeat(64),
          items: reviewed.items.map((item) => ({ ...item, included: false })),
          files: reviewed.files.filter((file) => file.path !== optionalFile),
        });
      const waitForRequests = (method: string, count: number) =>
        expect.poll(async () => (await gateway.getRequests(method)).length).toBe(count);
      await page.goto(`${server.baseUrl}templates?draft=${draftId}&agent=main`);
      const dialog = page.getByRole("dialog", { name: "Review your Template" });
      await dialog.waitFor();
      const proofDir = createControlUiE2eArtifactDir("templates-rename-creator-after");
      const frame = await takeControlUiScreenshotFrame(
        page,
        dialog,
        [dialog.getByRole("button", { name: "Publish to ClawHub" })],
        { animations: "disabled" },
      );
      await writeFile(`${proofDir}/after-creator.png`, frame.png);
      expect(await dialog.getByText("View", { exact: true }).count()).toBe(1);
      expect(await dialog.getByLabel("Description").inputValue()).toBe("Summarizes releases");
      await setReview("d");
      await dialog.getByRole("checkbox", { name: optionalFile }).uncheck();
      await waitForRequests("templates.drafts.review", 2);
      await gateway.deferNext("templates.drafts.publish");
      await dialog.getByRole("button", { name: "Publish to ClawHub" }).click();
      await gateway.waitForRequest("templates.drafts.publish");
      await expect
        .poll(() => dialog.locator("button.btn.primary").getAttribute("aria-busy"))
        .toBe("true");
      await dialog.locator(".btn__spinner").waitFor({ state: "visible" });
      await dialog.getByRole("button", { name: "Ask for changes" }).click();
      await dialog.waitFor({ state: "detached" });
      await gateway.rejectDeferred("templates.drafts.publish", {
        code: "UNAVAILABLE",
        message: "The package upload was interrupted.",
      });
      const publicationError = page.getByRole("alert");
      await publicationError.waitFor();
      expect(await publicationError.textContent()).toContain("The package upload was interrupted.");
      expect(await page.getByRole("button", { name: "Review Template package" }).count()).toBe(0);
      await setReview("e");
      await publicationError.getByRole("button", { name: "Retry review" }).click();
      await waitForRequests("templates.drafts.review", 3);
      await dialog.getByRole("button", { name: "Publish to ClawHub" }).click();
      await waitForRequests("templates.drafts.publish", 2);
      const published = await gateway.getRequests("templates.drafts.publish");
      expect(published[1]?.params).toMatchObject({
        reviewToken: "e".repeat(64),
        choices: {
          excluded: [`file:${optionalFile}`],
        },
      });
      await page
        .getByText("Submitted to ClawHub. Publication pending security review.")
        .waitFor({ state: "visible" });
      await page.getByRole("button", { name: "View on ClawHub" }).waitFor({ state: "visible" });
      expect(await page.locator(".template-creator__notice").count()).toBe(0);
      expect(await dialog.count()).toBe(0);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);

// Task-only final-effect proof. Ordinary UI CI keeps its focused mock-socket
// cases; this opt-in owns two real Gateway processes and local inference.
it.skipIf(!process.env.OPENCLAW_TEMPLATE_CREATOR_AUTHORITY_PROOF)(
  "dispatches an allowed creator once and rejects replaced or revoked authority through real Gateways",
  async () => {
    const provider = await startScrollInferenceFixture();
    const instances: OpenClawTestInstance[] = [];
    let browser: Browser | undefined;
    let admin: Awaited<ReturnType<typeof connectChatGateway>> | undefined;
    try {
      for (const name of ["creator-authority-a", "creator-authority-b"]) {
        const instance = await createChatGatewayInstance({
          name,
          provider: "creator-fixture",
          identity: "Creator proof",
          model: "echo",
          apiKey: "synthetic-creator-fixture-key",
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          models: [{ id: "echo", name: "Local synthetic inference" }],
          config: {
            gateway: {
              controlUi: {
                enabled: true,
                experimental: { templates: true },
                ...(instances[0]
                  ? { allowedOrigins: [`http://127.0.0.1:${instances[0].port}`] }
                  : {}),
              },
            },
          },
        });
        instances.push(instance);
        // These processes exercise private draft creation, never a real registry
        // identity. The generic fixture inherits environment keys beyond HOME.
        for (const key of [
          "CLAWHUB_TOKEN",
          "CLAWHUB_AUTH_TOKEN",
          "CLAWHUB_CONFIG_PATH",
          "CLAWDHUB_CONFIG_PATH",
        ]) {
          delete instance.env[key];
        }
        instance.env.XDG_CONFIG_HOME = instance.state.path("xdg-config");
        const config = JSON.parse(await readFile(instance.configPath, "utf8"));
        config.agents.defaults.workspace = instance.state.workspaceDir;
        await instance.state.writeConfig(config);
        await mkdir(path.join(instance.state.workspaceDir, ".openclaw/template-drafts"), {
          recursive: true,
        });
        await instance.startGateway();
      }
      const [first, second] = instances;
      if (!first || !second) {
        throw new Error("Both real creator Gateways must be started");
      }
      admin = await connectChatGateway(first, new AbortController().signal);
      browser = await chromium.launch({ executablePath });
      const draftFiles = () =>
        Promise.all(
          instances.map((instance) =>
            readdir(path.join(instance.state.workspaceDir, ".openclaw/template-drafts")),
          ),
        );
      for (const mode of ["allowed", "replacement", "revoked"] as const) {
        const page = await browser.newPage(createDarkDesktopControlUiContextOptions());
        const release = Promise.withResolvers<void>();
        const writes: { id: string; method: string }[] = [];
        const replies = new Map<string, { ok: boolean; draftId?: string; status?: string }>();
        // Read actual native browser frames. Retain no connect/auth frames,
        // request contents, credentials, device IDs or non-public endpoints.
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const frame = asOptionalRecord(JSON.parse(String(payload)));
            if (
              frame?.type === "req" &&
              typeof frame.id === "string" &&
              (frame.method === "templates.drafts.create" || frame.method === "chat.send")
            ) {
              writes.push({ id: frame.id, method: frame.method });
            }
          });
          socket.on("framereceived", ({ payload }) => {
            const frame = asOptionalRecord(JSON.parse(String(payload)));
            if (
              frame?.type === "res" &&
              typeof frame.id === "string" &&
              writes.some((request) => request.id === frame.id)
            ) {
              const result = asOptionalRecord(frame.payload);
              replies.set(frame.id, {
                ok: frame.ok === true,
                ...(typeof result?.draftId === "string" ? { draftId: result.draftId } : {}),
                ...(typeof result?.status === "string" ? { status: result.status } : {}),
              });
            }
          });
        });
        try {
          const baseUrl = `http://127.0.0.1:${first.port}/`;
          await seedSidebarSettings(page, baseUrl, { sidebarAgentsMode: "roster" });
          await pairFixture(page, first);
          await assertServedUi(page, baseUrl);
          const before = await draftFiles();
          let runtimeUrl: string | undefined;
          await page.route("**/assets/template-creator-runtime-*.js", async (route) => {
            runtimeUrl = route.request().url();
            await release.promise;
            await route.continue();
          });
          const row = page.locator('.sidebar-agent-roster__row[data-agent-id="main"]');
          await row.hover();
          await page.getByRole("button", { name: "Options for Creator proof" }).click();
          await page.getByRole("menuitem", { name: "Create Template", exact: true }).click();
          await expect.poll(() => runtimeUrl).toBeTruthy();
          expect(writes).toEqual([]);
          const application = await getControlUiContextHandle(page);
          const originalClient = await application.evaluateHandle(
            (context) => context.gateway.snapshot.client,
          );
          const revision = await application.evaluate(
            (context) => context.gateway.connectionRevision,
          );
          const turn = mode === "allowed" ? provider.plan() : undefined;
          try {
            if (mode === "replacement") {
              await application.evaluate((context) => context.navigate("connection"));
              await waitForControlUiRoute(page, { routeId: "connection" });
              const connection = page.locator("openclaw-connection-page .settings-section").filter({
                has: page.locator(".settings-section__heading").getByText("Connection", {
                  exact: true,
                }),
              });
              await connection.getByLabel("Gateway URL", { exact: true }).fill(second.url);
              await connection
                .getByLabel("Gateway secret", { exact: true })
                .fill(second.gatewayToken);
              await connection
                .getByRole("button", {
                  name: "Apply and reconnect",
                  exact: true,
                })
                .click();
              await waitForControlUiGatewayReady(page);
              expect(
                await application.evaluate(
                  (context, client) => context.gateway.snapshot.client === client,
                  originalClient,
                ),
              ).toBe(false);
              expect(
                await application.evaluate((context) => context.gateway.connectionRevision),
              ).toBe(revision + 1);
            } else if (mode === "revoked") {
              const deviceId = await page.evaluate(() => {
                const identity = localStorage.getItem("openclaw-device-identity-v1");
                return identity ? JSON.parse(identity).deviceId : undefined;
              });
              expect(typeof deviceId).toBe("string");
              await admin.request("device.token.revoke", { deviceId, role: "operator" });
              await expect
                .poll(() => application.evaluate((context) => context.gateway.snapshot.phase))
                .not.toBe("connected");
            }
            release.resolve();
            if (!runtimeUrl) {
              throw new Error("The actual creator runtime request was not held");
            }
            await page.evaluate(
              `import(${JSON.stringify(runtimeUrl)}).then(() => new Promise(resolve => window.setTimeout(resolve, 0)))`,
            );
            if (mode === "allowed") {
              await expect
                .poll(() => writes.map((request) => replies.get(request.id)))
                .toEqual([
                  expect.objectContaining({ ok: true, draftId: expect.any(String) }),
                  expect.objectContaining({ ok: true, status: "started" }),
                ]);
              expect(writes.map((request) => request.method)).toEqual([
                "templates.drafts.create",
                "chat.send",
              ]);
              const draftId = replies.get(writes[0]!.id)?.draftId;
              expect(draftId).toMatch(/^[a-f0-9-]{36}$/u);
              const draft = JSON.parse(
                await readFile(
                  path.join(
                    first.state.workspaceDir,
                    ".openclaw/template-drafts",
                    draftId + ".json",
                  ),
                  "utf8",
                ),
              );
              expect(draft).toMatchObject({ name: "my-template", files: [] });
              await expect.poll(provider.requests).toBe(1);
              await turn!.append("The private Template draft is ready for editing.");
              await turn!.finish();
              const after = await draftFiles();
              expect(after[0]).toHaveLength(before[0]!.length + 1);
              expect(after[1]).toEqual(before[1]);
            } else {
              expect(writes).toEqual([]);
              expect(await draftFiles()).toEqual(before);
            }
            console.log(
              "CREATOR_REAL_AUTHORITY_TRACE",
              JSON.stringify({
                case: mode,
                transport: "native browser WebSocket to actual Gateway",
                uiEntryAuthenticated: true,
                moduleEvaluated: true,
                writes: writes.map((request) => ({
                  method: request.method,
                  accepted: replies.get(request.id)?.ok === true,
                })),
                draftFiles: (await draftFiles()).map((files) => files.length),
                inferenceRequests: provider.requests(),
              }),
            );
          } finally {
            await originalClient.dispose();
            await application.dispose();
          }
        } finally {
          release.resolve();
          await page.close();
        }
      }
      expect(provider.failures).toEqual([]);
    } finally {
      await runQaGatewayFixture(
        async () => {
          await browser?.close();
        },
        () => admin?.stopAndWait({ timeoutMs: 1_000 }),
        ...instances.map((instance) => () => instance.cleanup()),
        () => provider.close(),
      );
    }
  },
  120_000,
);
