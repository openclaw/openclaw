import fs from "node:fs/promises";
import path from "node:path";
import type { WorkboardListResult } from "@openclaw/workboard-contract";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
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
const facade = { pluginId: "workboard", artifactBasename: "index.js" };
const runtimeSource = resolveBundledPluginPublicModulePath(facade);
const { default: workboard } = await loadBundledPluginFacade<{
  default: { register(api: OpenClawPluginApi): void };
}>(facade);
const { registerWorkboardGatewayMethods } = await loadBundledPluginFacade<{
  registerWorkboardGatewayMethods: (params: { api: OpenClawPluginApi }) => void;
}>({ pluginId: "workboard", artifactBasename: "runtime-api.js" });
async function createProgram() {
  const program = new Command().exitOverride();
  const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
  const api = createTestPluginApi({
    registrationMode: "cli-metadata",
    runtimeSource,
    registerCli,
  });
  workboard.register(api);
  for (const [register] of registerCli.mock.calls) {
    await register({ program, parentPath: [], config: fixture.config, logger: api.logger });
  }
  return (...args: string[]) => program.parseAsync(["workboard", ...args], { from: "user" });
}
const listCards = async () => (await invoke("workboard.cards.list", {})) as WorkboardListResult;
async function expectCards(...expected: Record<string, unknown>[]) {
  const { cards } = await listCards();
  expect(cards).toEqual(expected.map((card) => expect.objectContaining(card)));
  return cards;
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
it("routes Workboard writes to the resident owner and invalidates its warmed list", async () => {
  await startOwner();
  await invoke("workboard.cards.list", {});
  const cli = await createProgram();
  await cli("create", "Routed card");
  const id = (await expectCards({ title: "Routed card", status: "todo" }))[0]!.id;
  await cli("move", id, "--status", "review");
  await expectCards({ id, status: "review" });
});

it("never replays an uncertain Workboard create and rejects revoked authority", async () => {
  await startOwner();
  const cli = await createProgram();
  ownerTransport.failReply = true;
  await expect(cli("create", "Accepted once")).rejects.toThrow("No local fallback");
  ownerTransport.failReply = false;
  await expectCards({ title: "Accepted once" });
  ownerTransport.revokeBeforeMutation = true;
  await expect(cli("create", "Must not exist")).rejects.toThrow("No local fallback");
  ownerTransport.current = true;
  await expectCards({ title: "Accepted once" });
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
    const cli = await createProgram();
    await cli("create", "First", "--status", "ready");
    await cli("create", "Later", "--status", "ready");
    await cli("dispatch", "--admin", "--timeout", "12345");
    ownerTransport.current = true;
    const listed = await listCards();
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
  const cli = await createProgram();
  const database = path.join(process.env.OPENCLAW_STATE_DIR!, "plugins/workboard/workboard.sqlite");
  await expect(fs.stat(database)).rejects.toMatchObject({ code: "ENOENT" });
  await cli("create", "Offline card");
  await cli("list", "--json");
  expect(fixture.output).toContain("Offline card");
  const outputStart = fixture.output.length;
  await cli("dispatch", "--json");
  expect(JSON.parse(fixture.output.slice(outputStart))).toMatchObject({
    gatewayUnavailable: true,
    started: [],
    startFailures: [],
  });
  expect(ownerTransport.request).not.toHaveBeenCalled();
  expect(await readActiveGatewayLockIdentity({ env: process.env })).toBeUndefined();
});
