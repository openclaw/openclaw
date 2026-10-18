import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { type Command, Option } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import { hasFlag } from "../argv.js";
import { formatHelpExamples } from "../help-format.js";
import { withConsoleLogsRoutedToStderrForJson } from "../json-output-mode.js";
import {
  parseScreenRecordPayload,
  screenRecordTempPath,
  writeScreenRecordToFile,
} from "../nodes-screen.js";
import { setCommandJsonMode } from "../program/json-mode.js";
import { runNodesCommand, getNodesTheme } from "./cli-utils.js";
import { isNodesMachineOutput } from "./output-mode.js";
import { registerNodesCameraCommands } from "./register.camera.js";
import { registerNodesPairingCommands } from "./register.pairing.js";
import { registerNodesStatusCommands } from "./register.status.js";
import {
  buildNodeInvokeParams,
  callNodesGatewayCli,
  nodesCallOpts,
  parseOptionalNodeInteger,
  resolveCliNodeId,
  parseNodeDurationMs,
  parseOptionalNodeFiniteNumber,
} from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

// Generic node.invoke command with shell-exec commands intentionally blocked.

const BLOCKED_NODE_INVOKE_COMMANDS = new Set(["system.run", "system.run.prepare"]);

function parseNodeInvokeParams(value = "{}"): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("--params must be valid JSON.");
  }
}

/** Register the `nodes` command group and lazy plugin-provided node commands. */
export async function registerNodesCli(program: Command, argv: readonly string[] = process.argv) {
  const nodes = program
    .command("nodes")
    .description("Manage gateway-owned nodes (pairing, status, invoke, and media)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw nodes status", "List known nodes with live status."],
          ["openclaw nodes pending", "Show pending node pairing requests."],
          ["openclaw nodes remove --node <id|name|ip>", "Remove a stale paired node entry."],
          [
            'openclaw nodes invoke --node <id> --command system.which --params \'{"bins":["uname"]}\'',
            "Invoke a node command directly.",
          ],
          ["openclaw nodes camera snap --node <id>", "Capture a photo from a node camera."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/nodes", "docs.openclaw.ai/cli/nodes")}\n`,
    );

  registerNodesStatusCommands(nodes);
  registerNodesPairingCommands(nodes);
  nodesCallOpts(
    nodes
      .command("invoke")
      .description("Invoke a command on a paired node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--command <command>", "Command (e.g. canvas.navigate)")
      .option("--params <json>", "JSON object string for params", "{}")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 15000)", "15000")
      .option("--idempotency-key <key>", "Key to avoid duplicate requests (optional)")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("invoke", async () => {
          const nodeQuery = normalizeOptionalString(opts.node) ?? "";
          const command = normalizeOptionalString(opts.command) ?? "";
          if (!nodeQuery || !command) {
            throw new Error("--node and --command required");
          }
          if (BLOCKED_NODE_INVOKE_COMMANDS.has(command.toLowerCase())) {
            throw new Error(
              `command "${command}" is reserved for shell execution; use the exec tool with host=node instead`,
            );
          }
          const params = parseNodeInvokeParams(opts.params);
          const timeoutMs = parseOptionalNodeInteger(opts.invokeTimeout, "--invoke-timeout");
          if (opts.idempotencyKey === "") {
            throw new Error("--idempotency-key must not be empty.");
          }
          const nodeId = await resolveCliNodeId(opts, nodeQuery);

          const invokeParams = buildNodeInvokeParams({
            nodeId,
            command,
            params,
            idempotencyKey: opts.idempotencyKey,
            timeoutMs,
          });

          const result = await callNodesGatewayCli("node.invoke", opts, invokeParams);
          defaultRuntime.writeJson(result);
        });
      }),
    { timeoutMs: 30_000 },
  );
  nodesCallOpts(
    nodes
      .command("notify")
      .description("Send a local notification on a node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--title <text>", "Notification title")
      .option("--body <text>", "Notification body")
      .option("--sound <name>", "Notification sound")
      .addOption(
        new Option("--priority <passive|active|timeSensitive>", "Notification priority").choices([
          "passive",
          "active",
          "timeSensitive",
        ]),
      )
      .addOption(
        new Option("--delivery <system|overlay|auto>", "Delivery mode")
          .choices(["system", "overlay", "auto"])
          .default("system"),
      )
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 15000)", "15000")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("notify", async () => {
          const title = normalizeOptionalString(opts.title) ?? "";
          const body = normalizeOptionalString(opts.body) ?? "";
          if (!title && !body) {
            throw new Error("missing --title or --body");
          }
          const invokeTimeout = parseOptionalNodeInteger(opts.invokeTimeout, "--invoke-timeout");
          const nodeId = await resolveCliNodeId(opts, opts.node ?? "");
          const invokeParams = buildNodeInvokeParams({
            nodeId,
            command: "system.notify",
            params: {
              title,
              body,
              sound: opts.sound,
              priority: opts.priority,
              delivery: opts.delivery,
            },
            idempotencyKey: opts.idempotencyKey,
            timeoutMs: invokeTimeout,
          });

          const result = await callNodesGatewayCli("node.invoke", opts, invokeParams);
          if (opts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const { ok } = getNodesTheme();
          defaultRuntime.log(ok("notify ok"));
        });
      }),
  );
  nodesCallOpts(
    nodes
      .command("push")
      .description("Send an APNs test push to an iOS node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--title <text>", "Push title", "OpenClaw")
      .option("--body <text>", "Push body")
      .option("--environment <sandbox|production>", "Override APNs environment")
      .action(async (opts: NodesRpcOpts & { environment?: string }) => {
        await runNodesCommand("push", async () => {
          const environment = normalizeOptionalLowercaseString(opts.environment);
          if (
            opts.environment !== undefined &&
            environment !== "sandbox" &&
            environment !== "production"
          ) {
            throw new Error("invalid --environment (use sandbox|production)");
          }
          const nodeId = await resolveCliNodeId(opts, opts.node ?? "");
          const title = normalizeOptionalString(opts.title) || "OpenClaw";
          const body = normalizeOptionalString(opts.body) || `Push test for node ${nodeId}`;

          const result = await callNodesGatewayCli("push.test", opts, {
            nodeId,
            title,
            body,
            ...(environment ? { environment } : {}),
          });
          const parsed = asRecord(result);
          const ok = parsed.ok === true;
          const status = typeof parsed.status === "number" ? parsed.status : 0;
          const reason = normalizeOptionalString(parsed.reason);
          const env = normalizeOptionalString(parsed.environment) ?? "unknown";
          if (opts.json) {
            defaultRuntime.writeJson(result);
          } else {
            const { ok: okLabel, error: errorLabel } = getNodesTheme();
            const label = ok ? okLabel : errorLabel;
            defaultRuntime.log(label(`push.test status=${status} ok=${ok} env=${env}`));
            if (reason) {
              defaultRuntime.log(`reason: ${reason}`);
            }
          }
          if (!ok) {
            // Defer termination so the complete human/JSON result reaches stdout.
            process.exitCode = 1;
          }
        });
      }),
    { timeoutMs: 25_000 },
  );
  registerNodesCameraCommands(nodes);
  const screen = nodes
    .command("screen")
    .description("Capture screen recordings from a paired node");

  nodesCallOpts(
    screen
      .command("record")
      .description("Capture a short screen recording from a node (prints the saved path)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--screen <index>", "Screen index (0 = primary)", "0")
      .option("--duration <ms|10s>", "Clip duration (ms or 10s)", "10000")
      .option("--fps <fps>", "Frames per second", "10")
      .option("--no-audio", "Disable microphone audio capture")
      .option("--out <path>", "Output path")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 120000)", "120000")
      .action(async (opts: NodesRpcOpts & { out?: string }) => {
        await runNodesCommand("screen record", async () => {
          const durationMs = parseNodeDurationMs(opts.duration ?? "");
          const screenIndex = parseOptionalNodeInteger(
            opts.screen ?? "0",
            "--screen",
            "non-negative",
          );
          const fps = parseOptionalNodeFiniteNumber(opts.fps ?? "10", "--fps", {
            minExclusive: 0,
          });
          const timeoutMs = parseOptionalNodeInteger(opts.invokeTimeout, "--invoke-timeout");
          const nodeId = await resolveCliNodeId(opts, opts.node ?? "");

          const invokeParams = buildNodeInvokeParams({
            nodeId,
            command: "screen.record",
            params: {
              durationMs,
              screenIndex,
              fps,
              format: "mp4",
              includeAudio: opts.audio !== false,
            },
            timeoutMs,
          });

          const raw = await callNodesGatewayCli("node.invoke", opts, invokeParams);
          const parsed = parseScreenRecordPayload(asRecord(raw).payload);
          const filePath = opts.out ?? screenRecordTempPath({ ext: parsed.format });
          const written = await writeScreenRecordToFile(filePath, parsed.base64);

          if (opts.json) {
            defaultRuntime.writeJson({
              file: {
                path: written.path,
                durationMs: parsed.durationMs,
                fps: parsed.fps,
                screenIndex: parsed.screenIndex,
                hasAudio: parsed.hasAudio,
              },
            });
            return;
          }
          defaultRuntime.log(shortenHomePath(written.path));
        });
      }),
    { timeoutMs: 180_000 },
  );
  const location = nodes.command("location").description("Fetch location from a paired node");

  nodesCallOpts(
    location
      .command("get")
      .description("Fetch the current location from a node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--max-age <ms>", "Use cached location newer than this (ms)")
      .option(
        "--accuracy <coarse|balanced|precise>",
        "Desired accuracy (default: balanced/precise depending on node setting)",
      )
      .option("--location-timeout <ms>", "Location fix timeout (ms)", "10000")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("location get", async () => {
          const desiredAccuracyRaw = normalizeOptionalLowercaseString(opts.accuracy);
          const desiredAccuracy =
            desiredAccuracyRaw === "coarse" ||
            desiredAccuracyRaw === "balanced" ||
            desiredAccuracyRaw === "precise"
              ? desiredAccuracyRaw
              : undefined;
          if (opts.accuracy !== undefined && desiredAccuracy === undefined) {
            throw new Error("invalid --accuracy (use coarse|balanced|precise)");
          }
          const maxAgeMs = parseOptionalNodeInteger(opts.maxAge, "--max-age", "non-negative");
          const timeoutMs = parseOptionalNodeInteger(opts.locationTimeout, "--location-timeout");
          const invokeTimeoutMs = parseOptionalNodeInteger(opts.invokeTimeout, "--invoke-timeout");
          const nodeId = await resolveCliNodeId(opts, opts.node ?? "");

          const invokeParams = buildNodeInvokeParams({
            nodeId,
            command: "location.get",
            params: {
              maxAgeMs,
              desiredAccuracy,
              timeoutMs,
            },
            timeoutMs: invokeTimeoutMs,
          });

          const raw = await callNodesGatewayCli("node.invoke", opts, invokeParams);
          const payload = asRecord(asRecord(raw).payload);

          if (opts.json) {
            defaultRuntime.writeJson(payload);
            return;
          }

          const lat = payload.lat;
          const lon = payload.lon;
          const acc = payload.accuracyMeters;
          if (typeof lat === "number" && typeof lon === "number") {
            const accText = typeof acc === "number" ? ` ±${acc.toFixed(1)}m` : "";
            defaultRuntime.log(`${lat},${lon}${accText}`);
            return;
          }
          defaultRuntime.writeJson(payload, 0);
        });
      }),
    { timeoutMs: 30_000 },
  );
  setCommandJsonMode(nodes, "output", ({ argv: commandArgv }) => isNodesMachineOutput(commandArgv));

  // Built-ins and completion must not load the plugin runtime. Bare/root help
  // still needs plugin-provided subcommands.
  const { commandPath } = resolveCliArgvInvocation([...argv]);
  if (
    commandPath[0] === "completion" ||
    (commandPath[0] === "nodes" &&
      nodes.commands.some((command) => command.name() === commandPath[1]))
  ) {
    return;
  }
  const { registerPluginCliCommandsFromValidatedConfig } = await import("../../plugins/cli.js");
  const parentHelp =
    commandPath.length === 1 &&
    commandPath[0] === "nodes" &&
    (hasFlag([...argv], "--help") || hasFlag([...argv], "-h"));
  await withConsoleLogsRoutedToStderrForJson(
    argv,
    async () =>
      await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
        mode: parentHelp ? "metadata" : "lazy",
        primary: "nodes",
      }),
  );
}
