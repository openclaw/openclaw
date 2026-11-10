import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { retainGatewayResponsePayload } from "../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { writeConfigFile } from "../config/io.runtime.js";
import { registerRuntimeConfigWriteListener } from "../config/runtime-snapshot.js";
import { createExpectedProfileBinding } from "../gateway/expected-profile.js";
import { createDirectChatContext } from "../gateway/server-chat.agent-events.test-helpers.js";
import { withFixture } from "../gateway/server-methods/cron.inference-binding.test-support.js";
import { cronHandlers } from "../gateway/server-methods/cron.js";
import type { GatewayClient, RespondFn } from "../gateway/server-methods/types.js";
import { usersHandlers } from "../gateway/server-methods/users.js";
import { defaultRuntime } from "../runtime.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import type { GatewayRpcExtraOptions } from "./gateway-rpc.runtime.js";

const transport = vi.hoisted(() => ({ request: vi.fn() }));
// The CLI, Template Add, native cron handlers, persistence and rollback remain real.
// mock-isolation: Isolate state custody and RPC delivery in this native CLI fixture.
vi.mock("./local-state-owner.js", () => ({
  runWithLocalStateOwner: async ({ runLocal }: { runLocal: () => Promise<void> }) =>
    await runLocal(),
}));
vi.mock("./gateway-rpc.js", async (original) => ({
  ...(await original<typeof import("./gateway-rpc.js")>()),
  callGatewayFromCli: transport.request,
  callGatewayFromCliWithTransport: transport.request,
}));

const { runTemplatesAddCommand } = await import("./templates-cli.runtime.js");
afterEach(() => vi.restoreAllMocks());

it.each(
  [false, true].flatMap((profiled) =>
    ["lost-reply", "later-failure", "before-dispatch", "before-commit", "older-gateway"].map(
      (scenario) => ({
        profiled,
        scenario,
      }),
    ),
  ),
)("CLI retains native creator receipt ($profiled, $scenario)", async ({ profiled, scenario }) => {
  await withFixture(async (fixture) => {
    const root = process.env.OPENCLAW_STATE_DIR!;
    const agentId = "cli-cron-receipt";
    const people = await fixture.personalAccount();
    const client: GatewayClient = profiled
      ? people.owner
      : { connId: "unprofiled-cli", connect: people.owner.connect };
    if (profiled) {
      fixture.setDefaultProfile(people.profileId);
    }
    const laterFailure = scenario === "later-failure";
    const transferred = scenario === "before-dispatch" || scenario === "before-commit";
    const unsupportedAbsence = scenario === "older-gateway" && !profiled;
    const transfer = () => {
      client.authenticatedUserProfile = people.other.authenticatedUserProfile;
    };
    fixture.publish({
      gateway: { mode: "local", controlUi: { experimental: { templates: true } } },
      agents: {
        ...fixture.getConfig().agents,
        defaults: {
          ...fixture.getConfig().agents?.defaults,
          workspace: path.join(root, "workspaces"),
        },
      },
    });
    await writeConfigFile(fixture.getConfig());
    const source = path.join(root, "CLAW.md");
    await fs.writeFile(
      source,
      `---\n${JSON.stringify({
        schemaVersion: 1,
        agent: { id: agentId },
        automations: (laterFailure ? ["first", "second"] : ["first"]).map((id) => ({
          id,
          enabled: false,
          schedule: { cron: "0 9 * * 1", timezone: "UTC" },
          session: "isolated",
          message: "Compare synthetic public sources.",
        })),
      })}\n---\nResearch public sources.\n`,
    );
    const output: unknown[] = [];
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => output.push(value));
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
    // Gateway admission retains the catalog consumed by native human cron reads.
    const profiles = await prepareUserProfileCatalog();
    const unsubscribe = registerRuntimeConfigWriteListener((event) => {
      fixture.publish(event.sourceConfig);
    });
    if (scenario === "before-commit") {
      const add = fixture.getCron().add.bind(fixture.getCron());
      vi.spyOn(fixture.getCron(), "add").mockImplementationOnce(async (...args) => {
        transfer();
        return await add(...args);
      });
    }
    transport.request.mockClear();
    transport.request.mockImplementation(
      async (
        method: string,
        _opts: unknown,
        params: Record<string, unknown>,
        extra?: GatewayRpcExtraOptions,
      ) => {
        if (method === "config.get") {
          return {
            config: fixture.getConfig(),
            configRevisionHash: "synthetic-applied-config",
            appliedConfigHash: "synthetic-applied-config",
          };
        }
        const prepared = await extra?.prepareAuthenticatedRequest?.(
          async (childMethod, childParams) => await transport.request(childMethod, {}, childParams),
          new AbortController().signal,
        );
        if (unsupportedAbsence && method === "cron.add") {
          expect(prepared?.expectedProfileId).toBeNull();
          const failure = new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "invalid request frame: at /expectedProfileId: must be string",
          });
          retainGatewayResponsePayload(failure, undefined);
          throw failure;
        }
        if (prepared && scenario === "before-dispatch") {
          transfer();
        }
        const binding = await createExpectedProfileBinding(prepared?.expectedProfileId, client);
        binding?.assertCurrent();
        const handler = cronHandlers[method] ?? usersHandlers[method];
        if (!handler) {
          throw new Error(`Unexpected CLI RPC: ${method}`);
        }
        if (method === "cron.add" && params.name === "second") {
          throw new Error("Second schedule rejected before commit");
        }
        const respond = vi.fn<RespondFn>();
        await handler({
          req: { type: "req", id: "cli-cron-receipt", method, params },
          params,
          respond,
          client,
          sessionMutationCommitGuard: () => binding?.assertCurrent(),
          hasCurrentClientAuthority: () => !client.invalidated,
          context: createDirectChatContext({
            cron: fixture.getCron(),
            getRuntimeConfig: fixture.getConfig,
            getClientConnIds: (filter) =>
              new Set(client.connId && (!filter || filter(client)) ? [client.connId] : []),
          }),
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledOnce();
        const [ok, result, error] = respond.mock.calls[0]!;
        if (!ok) {
          const failure = new GatewayClientRequestError(error ?? {});
          retainGatewayResponsePayload(failure, result);
          throw failure;
        }
        if (method === "cron.add") {
          throw new Error("CLI RPC reply lost after native commit");
        }
        return result;
      },
    );
    try {
      await runTemplatesAddCommand(source, { workspace: path.join(root, "workspace"), json: true });
      expect(output).toHaveLength(1);
      expect(output[0]).toMatchObject({
        status: laterFailure || transferred || unsupportedAbsence ? "partial" : "complete",
      });
      expect(
        await fixture.getCron().list({ includeDisabled: true }),
        JSON.stringify(output),
      ).toHaveLength(laterFailure || transferred || unsupportedAbsence ? 0 : 1);
      if (unsupportedAbsence) {
        expect(JSON.stringify(output)).toContain(
          "Update OpenClaw on the Gateway host to match this CLI, restart the Gateway",
        );
        expect(
          transport.request.mock.calls.filter(([method]) => method === "cron.add"),
        ).toHaveLength(1);
      }
      if (!laterFailure && !transferred && !unsupportedAbsence) {
        expect(fixture.getConfig().agents?.entries?.[agentId]).toBeDefined();
        const [stored] = await fixture.getCron().list({ includeDisabled: true });
        expect(stored?.ownerProfileId).toBe(
          profiled ? people.owner.authenticatedUserProfile?.profileId : undefined,
        );
        expect(output[0]).toMatchObject({
          cronJobs: [expect.objectContaining({ schedulerJobId: stored?.id })],
        });
      }
    } finally {
      unsubscribe();
      profiles.release();
    }
  });
});
