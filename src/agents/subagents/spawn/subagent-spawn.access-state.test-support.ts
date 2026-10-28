import { expect, it, onTestFinished, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import * as agentScope from "../../agent-scope.js";
import {
  createBoundSpawnInvocation,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

type BoundParent = Awaited<ReturnType<NativePluginSpawnTestOptions["createBoundParent"]>>;
type AccessStateOptions = NativePluginSpawnTestOptions & {
  parentSessionKey: string;
  holdModelRun: (
    bound: BoundParent,
    text: string,
  ) => { started: Promise<void>; finish: () => void };
};

export function registerAccessStateSpawnCases(options: AccessStateOptions) {
  const {
    createBoundParent,
    createBoundGateway,
    closeBoundGateway,
    throwBoundFailures,
    waitForEmbeddedRun,
    runEmbeddedAgent,
    holdModelRun,
    parentSessionKey,
  } = options;
  it.each([
    { label: "default", parent: undefined, requested: undefined, expected: undefined },
    {
      label: "explicit Standard",
      parent: "daybreak_blue",
      requested: "standard",
      expected: "standard",
    },
    {
      label: "null inherits Red",
      parent: "daybreak_red",
      requested: null,
      expected: "daybreak_red",
    },
    {
      label: "visible explicit Blue",
      parent: undefined,
      requested: "daybreak_blue",
      expected: "daybreak_blue",
      visible: true,
    },
    {
      label: "visible inherited Red",
      parent: "daybreak_red",
      requested: undefined,
      expected: "daybreak_red",
      visible: true,
    },
  ] as const)(
    "persists $label Access through real spawn and command admission",
    async (scenario) => {
      // The shared model-catalog fixture defaults agent resolution to "default".
      // Exercise the real session-key resolver, including visible incarnation checks.
      const actual = await vi.importActual<typeof agentScope>("../../agent-scope.js");
      const resolver = vi
        .spyOn(agentScope, "resolveSessionAgentIds")
        .mockImplementation(actual.resolveSessionAgentIds);
      onTestFinished(() => {
        resolver.mockRestore();
      });
      const { parent, requested, expected } = scenario;
      const visible = "visible" in scenario && scenario.visible;
      const bound = await createBoundParent();
      await upsertSessionEntryCore(
        { storePath: bound.storePath, sessionKey: parentSessionKey },
        { cyberAccessProgram: parent },
      );
      const { runtime } = await createBoundGateway(bound);
      const modelRun = holdModelRun(bound, "Access child completed");
      let childRunId: string | undefined;
      const failures: unknown[] = [];
      try {
        const result = await createBoundSpawnInvocation(
          bound,
          { cyberAccessProgram: requested, visible },
          { provider: "custom", model: "test-model" },
        )();
        expect(result.details).toMatchObject({ status: "accepted" });
        const details = result.details as { childSessionKey: string; runId: string };
        childRunId = details.runId;
        await waitForEmbeddedRun(bound, details.runId, modelRun.started);
        // Read the child written by the production Gateway, not a mocked patch.
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: details.childSessionKey })
            ?.cyberAccessProgram,
        ).toBe(expected);
        // Agent-command consumes that saved child preference for its own runtime.
        expect(runEmbeddedAgent.mock.calls[0]?.[0].cyberAccessProgram).toBe(expected);
      } catch (error) {
        failures.push(error);
      } finally {
        modelRun.finish();
        failures.push(...(await closeBoundGateway(bound, runtime, childRunId)));
        throwBoundFailures(failures);
      }
    },
  );
}
