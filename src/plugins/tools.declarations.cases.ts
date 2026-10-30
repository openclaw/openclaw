import { expect, it, vi } from "vitest";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import type { resolvePluginTools as ResolvePluginTools } from "./tools.js";
import {
  createNamedToolEntry,
  createResolveToolsParams,
  createOptionalToolContext as createContext,
  type createToolRegistry,
  type MockRegistryToolEntry,
} from "./tools.optional.test-helpers.js";

/** Registers under the resolver suite's existing registry and metadata lifecycle. */
export function registerPluginDeclarationCases({
  setRegistry,
  resolvePluginTools,
}: {
  setRegistry: (entries: MockRegistryToolEntry[]) => ReturnType<typeof createToolRegistry>;
  resolvePluginTools: typeof ResolvePluginTools;
}): void {
  it("keeps opted-in declarations through restricted turns without retaining owner executors", async () => {
    const effect = vi.fn();
    const declaration = {
      name: "passive_probe",
      label: "Passive probe",
      description: "Configured operation",
      parameters: { type: "object", properties: {} },
      async: false as const,
    };
    const create = vi.fn((ctx: Parameters<MockRegistryToolEntry["factory"]>[0]) =>
      ctx.senderIsOwner
        ? Object.defineProperty(
            {
              ...declaration,
              description: "Current executor",
              outputSchema: { type: "string" },
              execute: async () => {
                ctx.assertInvocationCurrent?.();
                effect();
                return { content: [], details: {} };
              },
            },
            "prepareArguments",
            {
              value: (args: unknown) => {
                ctx.assertInvocationCurrent?.();
                return args;
              },
            },
          )
        : null,
    );
    const registry = setRegistry([
      createNamedToolEntry("passive", "passive_probe", {
        contextVersion: 2,
        declarations: [declaration],
        factory: create,
      }),
    ]);
    let current = true;
    const resolve = (senderIsOwner: boolean) =>
      resolvePluginTools({
        ...createResolveToolsParams({ context: { ...createContext(), senderIsOwner } }),
        assertInvocationCurrent() {
          if (!current) {
            throw new Error("run retired");
          }
        },
      });
    const first = resolve(true)[0]!;
    declaration.description = "mutated after admission";
    Object.defineProperty(declaration.parameters, "privateDefault", {
      value: "must not leak",
      enumerable: true,
    });
    const restricted = resolve(false)[0]!;
    const resumed = resolve(true)[0]!;
    for (const tool of [first, restricted, resumed]) {
      expect(tool).toMatchObject({
        name: "passive_probe",
        label: "Passive probe",
        description: "Configured operation",
        parameters: { type: "object", properties: {} },
        async: false,
      });
      expect(tool.parameters).not.toHaveProperty("privateDefault");
      expect(tool.outputSchema).toBeUndefined();
    }
    const args = { value: "current" };
    expect(first.prepareArguments?.(args)).toBe(args);
    await first.execute("ordinary", {});
    await expect(restricted.execute("internal", {})).rejects.toThrow(
      "unavailable in the current invocation",
    );
    await resumed.execute("ordinary-again", {});
    expect(create.mock.calls.map(([ctx]) => ctx.senderIsOwner)).toEqual([true, false, true]);
    expect(effect).toHaveBeenCalledTimes(2);
    current = false;
    await expect(resumed.execute("stale", {})).rejects.toThrow("run retired");
    expect(() => resumed.prepareArguments?.(args)).toThrow("run retired");
    current = true;
    markPluginRegistryRetired(registry as never);
    await expect(first.execute("old-generation", {})).rejects.toThrow("no longer active");
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it.each(["throw", "duplicate", "undeclared", "capability"] as const)(
    "retains passive presentation while refusing a %s factory result",
    async (failure) => {
      const effect = vi.fn();
      const declaration = {
        name: "passive_probe",
        label: "Probe",
        description: "Configured operation",
        parameters: { type: "object" },
      };
      const tool = {
        ...declaration,
        execute: async () => {
          effect();
          return { content: [], details: {} };
        },
      };
      setRegistry([
        createNamedToolEntry("passive", "passive_probe", {
          contextVersion: 2,
          declarations: [declaration],
          factory: () => {
            if (failure === "throw") {
              throw new Error("factory unavailable");
            }
            if (failure === "duplicate") {
              return [tool, tool];
            }
            if (failure === "undeclared") {
              return { ...tool, name: "other" };
            }
            return { ...tool, requiredClientCaps: ["private-surface"] };
          },
        }),
      ]);
      const tools = resolvePluginTools({
        ...createResolveToolsParams(),
        assertInvocationCurrent() {},
      });
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject(declaration);
      await expect(tools[0]!.execute("refused", {})).rejects.toThrow(
        "unavailable in the current invocation",
      );
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it.each(["deny", "optional", "capability"] as const)(
    "does not expose passive declarations excluded by %s policy",
    (policy) => {
      const declaration = {
        name: "passive_probe",
        label: "Probe",
        description: "Configured operation",
        parameters: { type: "object" },
        requiredClientCaps: ["surface"],
      };
      setRegistry([
        createNamedToolEntry("passive", "passive_probe", {
          contextVersion: 2,
          declarations: [declaration],
          optional: policy === "optional",
          factory: () => null,
        }),
      ]);
      const tools = resolvePluginTools(
        createResolveToolsParams({
          clientCaps: policy === "capability" ? [] : ["surface"],
          toolDenylist: policy === "deny" ? ["passive_probe"] : [],
        }),
      );
      expect(tools).toEqual([]);
    },
  );
}
