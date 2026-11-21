import type { Command } from "commander";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { addGatewayClientOptions, type GatewayRpcOpts } from "../gateway-rpc.js";
import { formatDocsHelp, formatHelpExamples } from "../help-format.js";
import { parseStrictPositiveIntOption } from "./helpers.js";

type PresenceInclude = "devices" | "network" | "location";

function isPresenceInclude(item: string): item is PresenceInclude {
  return item === "devices" || item === "network" || item === "location";
}

function parseInclude(raw: unknown): PresenceInclude[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0) {
    return undefined;
  }
  const out: PresenceInclude[] = [];
  for (const value of values) {
    const item = String(value);
    if (!isPresenceInclude(item)) {
      throw new Error(`--include must be devices, network, or location (got ${item}).`);
    }
    if (!out.includes(item)) {
      out.push(item);
    }
  }
  return out;
}

function presenceAction(
  load: () => Promise<
    (
      runtime: typeof defaultRuntime,
      opts: GatewayRpcOpts & {
        action?: "list" | "person" | "device";
        person?: string;
        deviceId?: string;
        include?: PresenceInclude[];
        limit?: number;
      },
    ) => Promise<void>
  >,
) {
  return async (opts: Record<string, unknown>) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const run = await load();
      const actionRaw = typeof opts.action === "string" ? opts.action : undefined;
      if (opts.action !== undefined && actionRaw === undefined) {
        throw new Error("--action must be list, person, or device.");
      }
      let action: "list" | "person" | "device" | undefined;
      if (actionRaw === undefined) {
        action = undefined;
      } else if (actionRaw === "list" || actionRaw === "person" || actionRaw === "device") {
        action = actionRaw;
      } else {
        throw new Error("--action must be list, person, or device.");
      }
      const limit =
        opts.limit === undefined
          ? undefined
          : typeof opts.limit === "string"
            ? parseStrictPositiveIntOption(opts.limit, "--limit")
            : (() => {
                throw new Error("--limit must be a positive integer.");
              })();
      await run(defaultRuntime, {
        action,
        person: typeof opts.person === "string" ? opts.person : undefined,
        deviceId: typeof opts.deviceId === "string" ? opts.deviceId : undefined,
        include: parseInclude(opts.include),
        limit,
        url: opts.url as string | undefined, // SAFETY: Gateway client option is string | undefined.
        port: opts.port as string | undefined, // SAFETY: Gateway client option is string | undefined.
        token: opts.token as string | undefined, // SAFETY: Gateway client option is string | undefined.
        password: opts.password as string | undefined, // SAFETY: Gateway client option is string | undefined.
        timeout: opts.timeout as string | undefined, // SAFETY: Gateway client option is string | undefined.
        json: Boolean(opts.json),
      });
    });
  };
}

export function registerPresenceCommand(program: Command) {
  const presence = program
    .command("presence")
    .description("Query people and devices presence via the Gateway")
    .addHelpText("after", () =>
      formatDocsLinkNote(
        "Distinct from `openclaw system presence` (raw system-presence roster). Prefer this over `gateway call presence.query`.",
      ),
    );

  addGatewayClientOptions(
    presence
      .command("query")
      .description("Query connected people and devices (presence.query)")
      .option("--action <action>", "list (default), person, or device")
      .option("--person <selector>", "For person: me, person/profile id, or unambiguous name")
      .option("--device-id <id>", "For device: presence device id from a prior query")
      .option(
        "--include <field>",
        "Repeatable: devices, network, and/or location",
        (value: string, previous: string[]) => [...previous, value],
        [] as string[], // SAFETY: Commander collect default is an empty string array.
      )
      .option("--limit <n>", "Max people for list (1-100; Gateway default 50)")
      .option("--json", "Output JSON", false)
      .addHelpText(
        "after",
        () =>
          `\n${theme.heading("Examples:")}\n${formatHelpExamples([
            ["openclaw presence query --json", "List connected people."],
            [
              "openclaw presence query --action person --person me --include devices --json",
              "Inspect the authenticated person with device rows.",
            ],
            [
              "openclaw presence query --port 18789 --token $TOKEN --json",
              "Target a local Gateway port.",
            ],
          ])}\n\n${theme.muted(
            "Backed by presence.query (operator.read). Prefer this over gateway call presence.query. Distinct from system presence.",
          )}`,
      )
      .action(
        presenceAction(
          async () => (await import("../../commands/presence-query.js")).presenceQueryCommand,
        ),
      ),
  );
}

function formatDocsLinkNote(text: string): string {
  return `\n${theme.muted(text)}\n${formatDocsHelp("concepts/presence")}`;
}
