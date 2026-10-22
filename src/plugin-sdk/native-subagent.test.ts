import { expectTypeOf, it } from "vitest";
import type { OpenClawPluginApi } from "./plugin-entry.js";

type Native = NonNullable<OpenClawPluginApi["runtime"]["subagent"]["native"]>;

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
  }>();
  expectTypeOf<Parameters<Native["collect"]>[0]>().toEqualTypeOf<{
    ids: string[];
    timeoutSeconds?: number;
    awaitResults?: boolean;
  }>();
  expectTypeOf<
    Awaited<ReturnType<Native["collect"]>>["completed"][number]["status"]
  >().toEqualTypeOf<"done" | "failed" | "killed" | "timeout">();
});
