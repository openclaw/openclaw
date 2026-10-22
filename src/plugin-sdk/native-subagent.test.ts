import { expectTypeOf, it } from "vitest";
import type { OpenClawPluginApi } from "./plugin-entry.js";

type Native = NonNullable<OpenClawPluginApi["runtime"]["subagent"]["native"]>;
type Command = Parameters<OpenClawPluginApi["registerCommand"]>[0];
type CommandContext = Parameters<Command["handler"]>[0];
type SelectionControls = {
  model?: string;
  thinking?: string;
  fastMode?: boolean | "auto" | "ultrafast";
};
type Selection = {
  requested: SelectionControls;
  resolved?: SelectionControls;
  observed?: SelectionControls;
};

it("exports the optional native contract through the public plugin API", () => {
  expectTypeOf<OpenClawPluginApi["runtime"]["subagent"]["native"]>().toEqualTypeOf<
    Native | undefined
  >();
  expectTypeOf<Parameters<Native["spawn"]>[0]["model"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<Parameters<Native["spawn"]>[0]["thinking"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<Parameters<Native["spawn"]>[0]["fastMode"]>().toEqualTypeOf<
    boolean | "auto" | "ultrafast" | undefined
  >();
  expectTypeOf<Awaited<ReturnType<Native["spawn"]>>>().toEqualTypeOf<{
    runId: string;
    childSessionKey: string;
    completionMode: "collect";
    selection?: Selection;
  }>();
  type List = NonNullable<Native["list"]>;
  type Child = Awaited<ReturnType<List>>[number];
  expectTypeOf<Native["list"]>().toEqualTypeOf<List | undefined>();
  expectTypeOf<ThisParameterType<List>>().toEqualTypeOf<void>();
  expectTypeOf<Parameters<List>[0]>().toEqualTypeOf<{ status?: Child["status"] } | undefined>();
  expectTypeOf<Child>().toEqualTypeOf<{
    runId: string;
    childSessionKey: string;
    requestId: string;
    label?: string;
    status:
      | "queued"
      | "running"
      | "interrupted"
      | "terminal"
      | "done"
      | "failed"
      | "killed"
      | "timeout";
  }>();
  expectTypeOf<Parameters<Native["collect"]>[0]>().toEqualTypeOf<{
    ids: string[];
    timeoutSeconds?: number;
    awaitResults?: boolean;
  }>();
  expectTypeOf<
    Awaited<ReturnType<Native["collect"]>>["completed"][number]["status"]
  >().toEqualTypeOf<"done" | "failed" | "killed" | "timeout">();
  expectTypeOf<
    Awaited<ReturnType<Native["collect"]>>["completed"][number]["selection"]
  >().toEqualTypeOf<Selection | undefined>();
  expectTypeOf<NonNullable<CommandContext["runtimeContext"]>["subagents"]>().toEqualTypeOf<
    Native | undefined
  >();
  expectTypeOf<Command["runtimeCapabilities"]>().toEqualTypeOf<
    readonly ("subagents" | "models" | "scheduledTurns")[] | undefined
  >();
  type ScheduledTurns = NonNullable<
    NonNullable<CommandContext["runtimeContext"]>["scheduledTurns"]
  >;
  expectTypeOf<Parameters<ScheduledTurns["schedule"]>[0]["schedule"]>().toEqualTypeOf<
    { kind: "at"; at: string } | { kind: "every"; everyMs: number }
  >();
});
