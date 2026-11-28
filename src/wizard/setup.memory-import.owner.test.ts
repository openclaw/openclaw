import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { withMemoryMigrationProviders } from "../commands/migrate/memory-import.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { runMemorySetupFlow } from "../flows/memory-setup.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import { migrationsHandlers } from "../gateway/server-methods/migrations.js";
import type { RespondFn } from "../gateway/server-methods/types.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { createMigrationResourceFixture } from "../plugins/migration-provider.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createNonExitingRuntime } from "../runtime.js";
import { runSetupMemoryImportStep } from "./setup.memory-import.js";
import { detectSetupMigrationSources } from "./setup.migration-import.js";

const transport = vi.hoisted(() => ({
  external: false,
  call: vi.fn<(options: CallGatewayOptions) => Promise<unknown>>(),
}));
// mock-isolation: Simulate the CLI's absent process-local custody; physical locks,
// owner selection, Gateway migration handlers and native plugin execution stay real.
vi.mock("../infra/gateway-state-owner.js", async (original) => {
  const actual = await original<typeof import("../infra/gateway-state-owner.js")>();
  return {
    ...actual,
    captureGatewayStateOwner: (...args: Parameters<typeof actual.captureGatewayStateOwner>) =>
      transport.external ? undefined : actual.captureGatewayStateOwner(...args),
  };
});
// mock-isolation: Dispatch to real handlers in the owning process instead of opening a socket.
vi.mock("../gateway/call.js", async (original) => ({
  ...(await original<typeof import("../gateway/call.js")>()),
  callGateway: transport.call,
}));
afterEach(() => {
  transport.external = false;
  transport.call.mockReset();
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});

it.each(["accept", "decline", "empty", "lost response", "plan unavailable", "offline"] as const)(
  "keeps terminal memory import with %s",
  async (mode) => {
    const fixture = createMigrationResourceFixture({ detectFound: mode !== "empty" });
    const stateDir = path.join(fixture.root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    const configBytes = JSON.stringify(fixture.config);
    await fs.writeFile(configPath, configBytes);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_LOCALE", "en");
    const owner =
      mode === "offline"
        ? null
        : await acquireGatewayLock({ allowInTests: true, role: "gateway", port: 18789 });
    fixture.state.resumeApply.resolve();
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => fixture.config;
    transport.call.mockImplementation(async (options) => {
      if (mode === "plan unavailable") {
        // An older Gateway refuses before dispatch because it lacks the required method.
        throw new Error(`Gateway does not support ${options.method}`);
      }
      options.assertDispatchCurrent?.();
      if (!isRecord(options.params)) {
        throw new Error("Expected request parameters");
      }
      const params = options.params;
      const handler = migrationsHandlers[options.method];
      if (!handler || !owner) {
        throw new Error(`Unexpected method: ${options.method}`);
      }
      transport.external = false;
      try {
        let response: string | undefined;
        const respond = vi.fn<RespondFn>((ok, payload, error) => {
          response = JSON.stringify({ ok, payload, error });
        });
        await owner.run(() =>
          handler({
            params,
            respond,
            context,
            client: null,
            req: { type: "req", id: "terminal-proof", method: options.method },
            isWebchatConnect: () => false,
          }),
        );
        if (!response) {
          throw new Error("Gateway did not respond");
        }
        const { ok, payload, error } = JSON.parse(response);
        if (!ok) {
          throw new Error(error?.message);
        }
        if (mode === "lost response" && options.method === "migrations.memory.apply") {
          throw new Error("response lost after apply");
        }
        return payload;
      } finally {
        transport.external = true;
      }
    });
    transport.external = mode !== "offline";
    try {
      const prompter = createWizardPrompter({
        confirm: vi.fn(
          async ({ message }) => message !== "Set up memory embeddings?" && mode !== "decline",
        ),
      });
      expect(await runMemorySetupFlow(fixture.config, prompter)).toBe(fixture.config);
      const result = await runSetupMemoryImportStep({
        config: fixture.config,
        prompter,
        runtime: createNonExitingRuntime(),
      });
      expect(result.status).toBe(
        mode === "decline"
          ? "skipped"
          : mode === "empty" || mode === "plan unavailable"
            ? "nothing-to-import"
            : "completed",
      );
      const applied = mode === "accept" || mode === "lost response" || mode === "offline";
      expect(fixture.state.applyCalls).toBe(applied ? 1 : 0);
      const sourcePath = path.join(fixture.root, "source.sqlite");
      if (mode === "plan unavailable") {
        // The plugin opens its source on load: no owner planned and no local fallback ran.
        await expect(fs.access(sourcePath)).rejects.toThrow();
      } else {
        using database = new DatabaseSync(sourcePath);
        expect(database.prepare("SELECT COUNT(*) AS count FROM imports").get()?.count).toBe(
          applied ? 1 : 0,
        );
      }
      expect(transport.call.mock.calls.map(([options]) => options.method)).toEqual(
        mode === "offline"
          ? []
          : applied
            ? ["migrations.memory.plan", "migrations.memory.apply"]
            : ["migrations.memory.plan"],
      );
      if (mode === "plan unavailable") {
        expect(prompter.note).toHaveBeenCalledWith(
          "Import later from the dashboard's Memory import page (Settings → Import Memory).",
          "Memory import failed",
        );
      }
      if (mode === "lost response") {
        expect(result.providers[0]).toMatchObject({
          copiesIndeterminate: true,
          failure: expect.stringContaining("outcome may be partial"),
        });
      }
      if (mode === "accept") {
        expect(result.providers).toEqual([
          { providerId: fixture.id, label: "Native migration fixture", migrated: 1, skipped: 0 },
        ]);
      }
      expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
      if (owner) {
        await expect(
          withMemoryMigrationProviders(fixture.config, async () => undefined),
        ).rejects.toThrow("exclusive offline state ownership");
      }
    } finally {
      transport.external = false;
      await owner?.release();
      fixture.cleanup();
    }
  },
);

it("lets classic setup pass migration detection while a Gateway owns state", async () => {
  const fixture = createMigrationResourceFixture();
  const stateDir = path.join(fixture.root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  const owner = await acquireGatewayLock({ allowInTests: true, role: "gateway", port: 18789 });
  transport.external = true;
  try {
    expect(
      await detectSetupMigrationSources({
        config: fixture.config,
        runtime: createNonExitingRuntime(),
      }),
    ).toEqual({ detections: [], providerDescriptors: [] });
    // The plugin opens its source on load: detection did not load providers locally.
    await expect(fs.access(path.join(fixture.root, "source.sqlite"))).rejects.toThrow();
    expect(transport.call).not.toHaveBeenCalled();
  } finally {
    transport.external = false;
    await owner?.release();
    fixture.cleanup();
  }
});
