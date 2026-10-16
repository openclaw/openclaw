import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type { OpenClawPluginApi } from "../plugins/plugin-api.types.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../test-utils/bundled-plugin-public-surface.js";
import { useLocalStateOwnerFixture } from "./local-state-owner.fixture.test-support.js";
const fixture = useLocalStateOwnerFixture();
const { invoke, transport: ownerTransport } = fixture;
const runtimeSource = resolveBundledPluginPublicModulePath({
  pluginId: "workboard",
  artifactBasename: "index.js",
});
const { default: workboard } = await loadBundledPluginFacade<{
  default: { register(api: OpenClawPluginApi): void };
}>({ pluginId: "workboard", artifactBasename: "index.js" });
const { registerWorkboardGatewayMethods } = await loadBundledPluginFacade<{
  registerWorkboardGatewayMethods: (params: { api: OpenClawPluginApi }) => void;
}>({ pluginId: "workboard", artifactBasename: "runtime-api.js" });
async function program() {
  const result = new Command().exitOverride();
  const registrars: Array<Parameters<OpenClawPluginApi["registerCli"]>[0]> = [];
  const api = createTestPluginApi({
    registrationMode: "cli-metadata",
    runtimeSource,
    registerCli: (registrar) => {
      registrars.push(registrar);
    },
  });
  workboard.register(api);
  for (const registrar of registrars) {
    await registrar({
      program: result,
      parentPath: [],
      config: fixture.config,
      logger: api.logger,
    });
  }
  return result;
}
async function startOwner(runtime?: OpenClawPluginApi["runtime"]) {
  await fixture.startOwner();
  registerWorkboardGatewayMethods({
    api: createTestPluginApi({
      runtimeSource,
      runtime,
      registerGatewayMethod: (method, handler) => {
        fixture.handlers[method] = handler;
      },
      registerRuntimeLifecycle: (lifecycle) => {
        if (lifecycle.dispose) {
          fixture.disposers.push(lifecycle.dispose);
        }
      },
    }),
  });
}
describe("Workboard CLI owner routing", () => {
  it("routes Workboard writes to the resident owner and invalidates its warmed list", async () => {
    await startOwner();
    await invoke("workboard.cards.list", {});
    const cli = await program();
    await cli.parseAsync(["workboard", "create", "Routed card"], { from: "user" });
    const listed = (await invoke("workboard.cards.list", {})) as {
      cards: Array<{ id: string; status: string; title: string }>;
    };
    expect(listed.cards).toEqual([
      expect.objectContaining({ title: "Routed card", status: "todo" }),
    ]);
    const id = listed.cards[0]!.id;
    await cli.parseAsync(["workboard", "move", id, "--status", "review"], { from: "user" });
    expect(await invoke("workboard.cards.list", {})).toMatchObject({
      cards: [{ id, status: "review" }],
    });
    expect(ownerTransport.request.mock.calls.map(([request]) => request.method)).toEqual([
      "workboard.cards.create.owner",
      "workboard.cards.list.owner",
      "workboard.cards.move.owner",
    ]);
  });

  it("never replays an uncertain Workboard create and rejects revoked authority", async () => {
    await startOwner();
    const cli = await program();
    ownerTransport.failReply = true;
    await expect(
      cli.parseAsync(["workboard", "create", "Accepted once"], { from: "user" }),
    ).rejects.toThrow("No local fallback");
    ownerTransport.failReply = false;
    expect(await invoke("workboard.cards.list", {})).toMatchObject({
      cards: [{ title: "Accepted once" }],
    });
    ownerTransport.revokeBeforeMutation = true;
    await expect(
      cli.parseAsync(["workboard", "create", "Must not exist"], { from: "user" }),
    ).rejects.toThrow("No local fallback");
    ownerTransport.current = true;
    expect(await invoke("workboard.cards.list", {})).toMatchObject({
      cards: [{ title: "Accepted once" }],
    });
  });

  it.each(["accepted", "rejected"])(
    "settles a %s launch after the requester is revoked",
    async (outcome) => {
      const run = vi.fn(async ({ assertCurrent }: { assertCurrent?: () => void }) => {
        assertCurrent?.();
        ownerTransport.current = false;
        if (outcome === "rejected") {
          throw new Error("synthetic unaccepted launch");
        }
        return { runId: "accepted-run" };
      });
      await startOwner(createPluginRuntimeMock({ subagent: { run } }));
      const cli = await program();
      await cli.parseAsync(["workboard", "create", "First", "--status", "ready"], { from: "user" });
      await cli.parseAsync(["workboard", "create", "Later", "--status", "ready"], { from: "user" });
      await cli.parseAsync(["workboard", "dispatch", "--admin", "--timeout", "12345"], {
        from: "user",
      });
      ownerTransport.current = true;
      const listed = (await invoke("workboard.cards.list", {})) as {
        cards: Array<{ title: string }>;
      };
      expect(listed.cards.find((card) => card.title === "First")).toMatchObject({
        status: outcome === "accepted" ? "running" : "blocked",
        metadata: {
          automation: { launch: { phase: outcome === "accepted" ? "accepted" : "failed" } },
        },
        ...(outcome === "accepted" ? { runId: "accepted-run" } : {}),
      });
      expect(listed.cards.find((card) => card.title === "Later")).toMatchObject({
        status: "ready",
      });
      expect(run).toHaveBeenCalledOnce();
      expect(ownerTransport.request.mock.calls.at(-1)?.[0]).toMatchObject({ timeoutMs: 12345 });
    },
  );

  it("admits CLI metadata without opening SQLite and retains the offline command paths", async () => {
    const cli = await program();
    const database = path.join(
      process.env.OPENCLAW_STATE_DIR!,
      "plugins",
      "workboard",
      "workboard.sqlite",
    );
    await expect(fs.stat(database)).rejects.toMatchObject({ code: "ENOENT" });
    await cli.parseAsync(["workboard", "create", "Offline card"], { from: "user" });
    await cli.parseAsync(["workboard", "list", "--json"], { from: "user" });
    expect(fixture.output).toContain("Offline card");
    const outputStart = fixture.output.length;
    await cli.parseAsync(["workboard", "dispatch", "--json"], { from: "user" });
    expect(JSON.parse(fixture.output.slice(outputStart))).toMatchObject({
      gatewayUnavailable: true,
      started: [],
      startFailures: [],
    });
    expect(ownerTransport.request).not.toHaveBeenCalled();
    expect(await readActiveGatewayLockIdentity({ env: process.env })).toBeUndefined();
  });
});
