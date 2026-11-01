import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createSessionsCreateTool } from "../agents/tools/sessions-create-tool.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import {
  listSessionEntriesReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "./methods/registry.js";
import { runWithOperatorToolGatewayAuthority } from "./operator-tool-gateway-authority.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const PARENT_KEY = "agent:main:sandbox-authority-parent";
const LEASE_FREE_REFUSAL =
  "Session creation requires its live admitted operator and in-process Gateway";

type CreateOutcome =
  | { ok: true; details: Record<string, unknown> | undefined }
  | { ok: false; error: string };

/**
 * Sandboxed loopback run over a real in-process Gateway router: the projected
 * catalog comes from the shipped resolver, and "sessions.create" reaches the
 * real creation owner, so a successful call leaves a real session entry.
 */
async function withSandboxGateway(
  options: { lease: boolean; ambientOperator?: boolean },
  run: (bag: {
    names: string[];
    createFromCatalog: () => Promise<CreateOutcome>;
    createDirectly: () => Promise<CreateOutcome>;
    sessions: () => ReturnType<typeof listSessionEntriesReadOnly>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({}, async (state) => {
    const storePath = state.path("sessions.json");
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        defaults: { workspace: state.workspaceDir, sandbox: { mode: "all" } },
        entries: { main: {} },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: PARENT_KEY, storePath },
      { sessionId: "sandbox-authority-parent", updatedAt: 1, permissionMode: "full" },
    );
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      loadGatewayModelCatalog: async () => [
        {
          id: "sandbox-authority-model",
          name: "Sandbox authority model",
          provider: "test-provider",
        },
      ],
    });
    context.resolveGatewayContext = () => context;
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry(
        createCoreGatewayMethodDescriptors({
          "sessions.create": async (request: GatewayRequestHandlerOptions) => {
            await expectDefined(
              sessionCreateHandlers["sessions.create"],
              "creation owner",
            )(request);
          },
        }),
      );
    const controller = new AbortController();
    const signal = controller.signal;
    const lease = options.lease
      ? createAdmittedRunOperatorAuthority({
          profileId: "sandbox-authority-operator",
          scopes: ["operator.sessions.write"],
          signal,
          assertCurrent: () => {},
        })
      : undefined;
    // The operator-tool invocation scope is a real ambient authority source: a
    // Gateway-launched CLI run inherits it while projecting its catalog.
    const ambientAuthority = options.ambientOperator
      ? createAdmittedRunOperatorAuthority({
          profileId: "ambient-operator",
          scopes: ["operator.write", "operator.sessions.write"],
          signal,
          assertCurrent: () => {},
        })
      : undefined;
    const admission = prepareSystemAgentRunAdmission(
      cfg,
      "sandbox-authority-run",
      "main",
      "sandbox-authority",
      undefined,
      lease,
    );
    const admitted = await admission.admit("embedded");
    try {
      bindGatewayContextResolver(admitted, () => context);
      // Host-captured identity: operator authority comes from the admitted run only.
      const caller = expectDefined(
        createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: PARENT_KEY,
          approvalSignals: [signal],
        }),
        "caller",
      );
      const call = async <T>(fn: () => Promise<T>): Promise<T> => {
        const withIdentity = () => withGatewayToolCallerIdentity(caller, fn);
        return ambientAuthority
          ? runWithOperatorToolGatewayAuthority(
              {
                operatorRunAuthority: ambientAuthority,
                scopes: [...ambientAuthority.scopes],
                signal,
                assertCurrent: () => {},
              },
              withIdentity,
            )
          : withIdentity();
      };
      const invokeTool = async (
        makeTool: () => ReturnType<typeof createSessionsCreateTool>,
      ): Promise<CreateOutcome> => {
        try {
          // Construct inside the ambient scope: a lease-free run must be refused by
          // the effect owner even when the tool itself is not execution-gated.
          const result = await call(() =>
            makeTool().execute("sandbox-authority-create", {
              agentId: "main",
              label: "Sandbox authority child",
            }),
          );
          const details =
            typeof result === "object" && result !== null && "details" in result
              ? (result.details as Record<string, unknown> | undefined)
              : undefined;
          return { ok: true, details };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };
      const projection = await call(() =>
        resolveGatewayScopedTools({
          cfg,
          sessionKey: PARENT_KEY,
          surface: "loopback",
          senderIsOwner: false,
          admittedRunContext: admitted,
        }),
      );
      const catalogCreate = projection.tools.find((tool) => tool.name === "sessions_create");
      await run({
        names: projection.tools.map((tool) => tool.name),
        createFromCatalog: async () =>
          catalogCreate
            ? await invokeTool(() => catalogCreate)
            : { ok: false, error: "not in projected catalog" },
        createDirectly: async () => await invokeTool(() => createSessionsCreateTool()),
        sessions: () =>
          listSessionEntriesReadOnly({ agentId: "main", storePath, projection: "list" }),
      });
    } finally {
      admission.close();
    }
  });
}

it("creates a session through the sandbox catalog when the admitted run carries the lease", async () => {
  await withSandboxGateway({ lease: true }, async ({ names, createFromCatalog, sessions }) => {
    expect(names).toContain("sessions_create");
    const created = await createFromCatalog();
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const sessionKey = created.details?.sessionKey;
    expect(sessionKey).toEqual(expect.stringMatching(/^agent:main:/));
    const entries = sessions();
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.sessionKey === PARENT_KEY)?.entry.sessionId).toBe(
      "sandbox-authority-parent",
    );
    const child = entries.find((entry) => entry.sessionKey === sessionKey);
    expect(child?.entry.sessionId).toBe(created.details?.sessionId);
    expect(child?.entry.createdActor).toMatchObject({
      source: "profile",
      id: "sandbox-authority-operator",
    });
  });
});

it("refuses the same creation for a lease-free run under ambient authority without an effect", async () => {
  await withSandboxGateway(
    { lease: false, ambientOperator: true },
    async ({ names, createDirectly, sessions }) => {
      // Ambient authority projects nothing, and the effect owner still refuses the
      // run: creation needs the run's own captured lease, not the caller's scope.
      expect(names).not.toContain("sessions_create");
      expect(await createDirectly()).toEqual({ ok: false, error: LEASE_FREE_REFUSAL });
      expect(sessions()).toHaveLength(1);
    },
  );
});
