import type { Command } from "commander";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { addGatewayClientOptions, type GatewayRpcOpts } from "../gateway-rpc.js";
import { formatDocsHelp, formatHelpExamples } from "../help-format.js";
import { parseStrictPositiveIntOption } from "./helpers.js";

type PresenceInclude = "devices" | "network" | "location";

function parseInclude(raw: unknown): PresenceInclude[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0) {
    return undefined;
  }
  const allowed = new Set<PresenceInclude>(["devices", "network", "location"]);
  const out: PresenceInclude[] = [];
  for (const value of values) {
    const item = String(value);
    if (!allowed.has(item as PresenceInclude)) {
      throw new Error(`--include must be devices, network, or location (got ${item}).`);
    }
    if (!out.includes(item as PresenceInclude)) {
      out.push(item as PresenceInclude);
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
      const actionRaw = opts.action === undefined ? undefined : String(opts.action);
      const action =
        actionRaw === undefined || actionRaw === "list" || actionRaw === "person" || actionRaw === "device"
          ? (actionRaw as "list" | "person" | "device" | undefined)
          : (() => {
              throw new Error("--action must be list, person, or device.");
            })();
      const limit =
        opts.limit === undefined
          ? undefined
          : parseStrictPositiveIntOption(String(opts.limit), "--limit");
      await run(defaultRuntime, {
        action,
        person: opts.person === undefined ? undefined : String(opts.person),
        deviceId: opts.deviceId === undefined ? undefined : String(opts.deviceId),
        include: parseInclude(opts.include),
        limit,
        url: opts.url as string | undefined,
        port: opts.port as string | undefined,
        token: opts.token as string | undefined,
        password: opts.password as string | undefined,
        timeout: opts.timeout as string | undefined,
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
        [] as string[],
      )
      .option("--limit <n>", "Max people for list (1-100; Gateway default 50)")
      .option("--json", "Output JSON", false)
      .addHelpText(
        "after",
        () =>
          `\n${theme.heading("Examples:")}\n${formatHelpExamples([
            ["openclaw presence query --json", "List connected people."],
            [
              'openclaw presence query --action person --person me --include devices --json',
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
