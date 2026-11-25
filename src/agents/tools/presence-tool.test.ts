import { describe, expect, it, vi } from "vitest";
import type { GatewayMethodDescriptorInput } from "../../gateway/methods/descriptor.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { NodeRegistry } from "../../gateway/node-registry.js";
import { presenceHandlers } from "../../gateway/server-methods/presence.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { createTestOperatorAuthority } from "../admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createPresenceTool } from "./presence-tool.js";

const adaPresence = { people: [{ name: "Ada" }] };

function readerAuthority(scopes: string[]) {
  return createTestOperatorAuthority({
    profileId: ensureProfileForEmail("presence-reader@example.test").id,
    scopes,
  });
}

function fixture(locationHandler?: GatewayRequestHandler) {
  const context = createContext();
  const snapshot = vi.fn(() => [
    {
      ts: 1,
      connectionId: "ada-connection",
      ip: "203.0.113.2",
      user: { id: "ada", name: "Ada", identity: { type: "profile" as const, id: "ada" } },
    },
  ]);
  context.getPresenceSnapshot = snapshot;
  context.nodeRegistry = new NodeRegistry();
  const methods: GatewayMethodDescriptorInput[] = [
    {
      name: "presence.query",
      scope: "operator.read",
      owner: { kind: "core", area: "presence" },
      profileAccess: "required",
      handler: presenceHandlers["presence.query"]!,
    },
  ];
  if (locationHandler) {
    methods.push({
      name: "geolocation.lookup",
      scope: "operator.read",
      owner: { kind: "plugin", pluginId: "geolocation" },
      handler: locationHandler,
    });
  }
  const registry = createGatewayMethodRegistry(methods);
  context.getGatewayMethodRegistry = () => registry;

  async function run<T>(
    operatorAuthority: AdmittedRunOperatorAuthority | undefined,
    callback: (close: () => void) => Promise<T>,
    admissionSource?: AdmittedRunContext["admissionSource"],
  ): Promise<T> {
    const operationalRunInstance = createOperationalRunInstanceRef("presence-channel-run");
    const prepared = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance,
      operatorAuthority,
      admissionSource,
      facts: {
        runId: operationalRunInstance.runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "presence-test", state: "present" },
      },
    });
    const admitted = await prepared.admit("embedded");
    const approvalAuthority = getAdmittedRunDelegatedAuthority(admitted)!;
    try {
      return await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:discord:direct:requester",
          turnSourceChannel: "discord",
          operationalRunInstance,
          approvalAuthority,
          operatorAuthority,
          receiptAuthority: () => true,
          gatewayContextResolver: () => context,
        },
        () => callback(prepared.close),
      );
    } finally {
      prepared.close();
    }
  }
  return { snapshot, run };
}

describe("presence tool source authority", () => {
  it.each([{ kind: "local" }, { kind: "external", channel: "discord" }] as const)(
    "allows the captured $kind owner only while its source remains current",
    async (origin) => {
      const { run, snapshot } = fixture();
      let current = true;
      const capability = createCronCreatorAuthorityCapability(
        "presence-channel-run",
        origin,
        origin.kind === "external" ? { source: "channel-owner" } : undefined,
        () => current,
      )!;
      await run(undefined, () =>
        runWithCronCreatorAuthorityCapability(capability, async () => {
          const tool = createPresenceTool({ runId: "presence-channel-run" });
          expect((await tool.execute("owner", {})).details).toMatchObject(adaPresence);
          current = false;
          await expect(tool.execute("revoked-owner", {})).rejects.toThrow(/turn has ended/);
        }),
      );
      expect(snapshot).toHaveBeenCalledOnce();
    },
  );

  it.each(["operator-schedule", "requester-schedule"] as const)(
    "uses the admitted %s source without promoting requester schedules",
    async (source) => {
      const { run, snapshot } = fixture();
      await run(
        undefined,
        async (close) => {
          const tool = createPresenceTool();
          const pending = tool.execute("scheduled", {});
          if (source === "operator-schedule") {
            expect((await pending).details).toMatchObject(adaPresence);
            close();
            await expect(tool.execute("expired-schedule", {})).rejects.toThrow(/authority|source/i);
          } else {
            await expect(pending).rejects.toThrow(
              "Presence requires authenticated Gateway read access",
            );
          }
          expect(snapshot).toHaveBeenCalledTimes(source === "operator-schedule" ? 1 : 0);
        },
        source,
      );
    },
  );

  it.each([
    { scopes: undefined, allowed: false },
    { scopes: ["operator.read"], allowed: true },
    { scopes: ["operator.write"], allowed: true },
    { scopes: ["operator.sessions.write"], allowed: false },
    { scopes: [], allowed: false },
  ])("uses the original non-owner scopes $scopes", async ({ scopes, allowed }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const authority = scopes ? readerAuthority(scopes) : undefined;
      const { run, snapshot } = fixture();
      const pending = run(authority, () => createPresenceTool().execute("reader", {}));
      if (allowed) {
        expect((await pending).details).toMatchObject(adaPresence);
      } else {
        await expect(pending).rejects.toThrow(
          scopes
            ? /operator\.read|presence.*authority/i
            : /presence.*authority|presence.*authenticated|presence.*operator/i,
        );
      }
      expect(snapshot).toHaveBeenCalledTimes(allowed ? 1 : 0);
    });
  });
});
