import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareEventCoverage,
  extractGatewayEventNames,
  extractKotlinEnumStringConstants,
  extractKotlinHandledEvents,
  extractSwiftHandledEvents,
  extractSwiftStaticStringConstants,
} from "../../scripts/check-protocol-event-coverage.mts";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

const GATEWAY_LIST_FIXTURE = `
export const GATEWAY_EVENTS = [
  "connect.challenge", "chat", "session.message", "tick", "health",
  // comment noise
  "terminal.data", "terminal.exit", "presence", "cron", "shutdown", GATEWAY_EVENT_UPDATE_AVAILABLE,
];
`;

const GATEWAY_CONSTANTS_FIXTURE =
  'export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;\n';
const swiftConstants = extractSwiftStaticStringConstants(`
      enum ApprovalBridge {
        static let requestedKind = "exec.approval.requested"
      }
`);

describe("protocol event coverage", () => {
  it.each(["wrapper", "direct", "symlink", "import"])(
    "runs the %s entry without TSX and keeps imports quiet",
    (mode) => {
      const root = fs.realpathSync(createTempDir("protocol-coverage-entry-"));
      for (const file of [
        "check-protocol-event-coverage.mjs",
        "check-protocol-event-coverage.mts",
        "lib/protocol-codegen-names.mts",
        "lib/record-shared.mjs",
        "tsx.mjs",
        "lib/tsx-cli-shim.mjs",
        "lib/local-check-runtime.mts",
        "lib/managed-cleanup-handoff.mts",
      ]) {
        const target = path.join(root, "scripts", file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.resolve("scripts", file), target);
      }
      const alias = path.join(root, "alias");
      fs.symlinkSync(path.join(root, "scripts"), alias, "junction");
      const entry = path.join(
        mode === "symlink" ? alias : path.join(root, "scripts"),
        `check-protocol-event-coverage.${mode === "wrapper" ? "mjs" : "mts"}`,
      );
      const args =
        mode === "import"
          ? [
              "--input-type=module",
              "--eval",
              `await import(${JSON.stringify(pathToFileURL(entry).href)})`,
            ]
          : [entry];
      const result = spawnSync(requireNodeTool("node"), args, {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          PNPM_CONFIG_MODULES_DIR: "",
          pnpm_config_modules_dir: "",
          npm_config_modules_dir: "",
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(mode === "import" ? 0 : 1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        mode === "import"
          ? ""
          : "Protocol event coverage check failed: Required file src/gateway/events.ts is missing. If it moved, update scripts/check-protocol-event-coverage.mjs.\n",
      );
    },
  );

  it("collects literals and resolves identifiers", () => {
    const names = extractGatewayEventNames(GATEWAY_CONSTANTS_FIXTURE + GATEWAY_LIST_FIXTURE);
    expect(names).toContain("connect.challenge");
    expect(names).toContain("update.available");
    expect(names).toHaveLength(11);
  });

  it("fails loudly when the array is missing", () => {
    expect(() => extractGatewayEventNames("export const OTHER = [];")).toThrow(/GATEWAY_EVENTS/);
  });

  it("fails loudly on unresolved identifiers", () => {
    expect(() => extractGatewayEventNames(GATEWAY_LIST_FIXTURE)).toThrow(
      /GATEWAY_EVENT_UPDATE_AVAILABLE/,
    );
  });
  it("collects Swift events without resolving quoted constants or nested/non-event code", () => {
    const source = `
      static func mapEventFrame(_ evt: EventFrame) -> Event? {
        switch evt.event {
        case "tick": return .tick
        case "chat", "session.message":
            switch payload.kind {
            case "nested.ignored": return nil
            default: return .chat
            }
        case ApprovalBridge.requestedKind: return .approval
        case "ApprovalBridge.requestedKind": return .approval
        default: return nil
        }
      }
      func other(_ status: String) {
        switch status {
        case "ok", "completed": break
        default: break
        }
      }
      if evt.event == "connect.challenge" { return }
    `;
    expect([...extractSwiftHandledEvents(source, swiftConstants)].toSorted()).toEqual(
      "ApprovalBridge.requestedKind chat connect.challenge exec.approval.requested session.message tick".split(
        " ",
      ),
    );
  });

  it("collects literals and generated enum constants inside handler functions only", () => {
    const constants = extractKotlinEnumStringConstants(`
      enum class GatewayEvent(
        val rawValue: String,
      ) {
        ConnectChallenge("connect.challenge"),
        Health("health"),
        Other("other"),
        Modified("modified"),
        Commented("commented"),
        BlockCommented("block-commented"),
        NestedCommented("nested-commented"),
      }
    `);
    const source = `
      fun handleGatewayEvent(event: String, payloadJson: String?) {
        when (event) {
          "tick" -> { scope.launch { pollHealth() } }
          "chat" -> {
            when (parseKind(payloadJson)) {
              "nested.ignored" -> return
              else -> handleChat(payloadJson)
            }
          }
          "sessions.changed", "session.message" -> refresh()
          GatewayEvent.Health.rawValue, GatewayEvent.Other.rawValue -> refreshHealth()
          GatewayEvent.Modified.rawValue.uppercase() -> ignoreModifiedValue()
          // GatewayEvent.Commented.rawValue -> ignoreComment()
          /*
          GatewayEvent.BlockCommented.rawValue -> ignoreBlockComment()
          */
          /* outer
            /* inner */
            GatewayEvent.NestedCommented.rawValue -> ignoreNestedComment()
          */
          "slash//event", "block/*event*/" -> refreshCommentMarkers()
        }
      }
      private fun handleEvent(
        frame: JsonObject,
      ) {
        val event = frame["event"].asStringOrNull() ?: return
        val rawMarker = """/* raw string */ // raw string"""
        val templateMarker = "\${if (rawMarker.isEmpty()) "/* text */" else "// text"}"
        val slashMarker = '/'
        if (event == GatewayEvent.ConnectChallenge.rawValue) { return }
        if (event == GatewayEvent.Modified.rawValue.trim()) { ignoreModifiedValue() }
        // if (event == GatewayEvent.Commented.rawValue) { ignoreComment() }
        when {
          event == "when-condition" -> refreshCondition()
        }
        val isAssignment = event == "assignment"
        if (!isAssignment) { return }
        val other = keyEvent == "not.a.gateway.event"
      }
      internal fun gatewayEventInvalidatesNodesDevices(event: String): Boolean = event == "node.pair.requested" || event == "node.pair.resolved"
      fun topLevelNotAHandler(event: String) {
        if (event == "presence") { render() }
        when (event) {
          "cron" -> refresh()
        }
      }
    `;
    const handled = extractKotlinHandledEvents(source, constants);
    expect([...handled].toSorted()).toEqual(
      "assignment block/*event*/ chat connect.challenge health other session.message sessions.changed slash//event tick when-condition".split(
        " ",
      ),
    );
  });

  it("reports missing and stale allowances while accepting explained omissions", () => {
    const errors = compareEventCoverage({
      client: "ios",
      serverEvents: ["tick", "chat", "presence", "cron", "allowed", "unhandled"],
      handledEvents: new Set(["tick", "chat", "presence"]),
      allowlist: {
        allowed: "not rendered",
        presence: "now handled, should be removed",
        "gone.event": "no longer a gateway event",
        cron: "",
      },
    });
    expect(errors.toSorted()).toEqual([
      expect.stringContaining('"cron" needs a non-empty reason'),
      expect.stringContaining('"gone.event" is not a gateway event'),
      expect.stringContaining('"presence" is now handled'),
      expect.stringContaining('[ios] gateway event "unhandled"'),
    ]);
  });
});
