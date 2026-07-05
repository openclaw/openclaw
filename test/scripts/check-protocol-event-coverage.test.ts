// Check Protocol Event Coverage tests cover gateway event extraction and drift comparison.
import { describe, expect, it } from "vitest";
import {
  compareEventCoverage,
  extractGatewayEventNames,
  extractKotlinHandledEvents,
  extractSwiftHandledEvents,
} from "../../scripts/check-protocol-event-coverage.mjs";

const GATEWAY_LIST_FIXTURE = `
export const GATEWAY_EVENTS = [
  "connect.challenge",
  "chat",
  // comment noise
  "session.message",
  "tick",
  "health",
  "terminal.data",
  "terminal.exit",
  "presence",
  "cron",
  "shutdown",
  GATEWAY_EVENT_UPDATE_AVAILABLE,
];
`;

const GATEWAY_CONSTANTS_FIXTURE = `
export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;
`;

describe("extractGatewayEventNames", () => {
  it("collects literals and resolves identifiers", () => {
    const names = extractGatewayEventNames(GATEWAY_LIST_FIXTURE, GATEWAY_CONSTANTS_FIXTURE);
    expect(names).toContain("connect.challenge");
    expect(names).toContain("update.available");
    expect(names).toHaveLength(11);
  });

  it("fails loudly when the array is missing", () => {
    expect(() => extractGatewayEventNames("export const OTHER = [];", "")).toThrow(
      /GATEWAY_EVENTS/,
    );
  });

  it("fails loudly on unresolved identifiers", () => {
    expect(() => extractGatewayEventNames(GATEWAY_LIST_FIXTURE, "")).toThrow(
      /GATEWAY_EVENT_UPDATE_AVAILABLE/,
    );
  });
});

describe("extractSwiftHandledEvents", () => {
  it("collects switch case literals and comparisons, skipping nested and non-event code", () => {
    const source = `
      static func mapEventFrame(_ evt: EventFrame) -> Event? {
        switch evt.event {
        case "tick":
            return .tick
        case "chat", "session.message":
            guard let payload = evt.payload else { return nil }
            switch payload.kind {
            case "nested.ignored":
                return nil
            default:
                return .chat
            }
        case SomeBridge.requestedKind:
            return .approval
        default:
            return nil
        }
      }
      func other(_ status: String) {
        switch status {
        case "ok", "completed":
            break
        default:
            break
        }
      }
      if evt.event == "connect.challenge" { return }
    `;
    const handled = extractSwiftHandledEvents(source);
    expect([...handled].toSorted()).toEqual([
      "chat",
      "connect.challenge",
      "session.message",
      "tick",
    ]);
  });
});

describe("extractKotlinHandledEvents", () => {
  it("collects when-block case literals and comparisons at the top level only", () => {
    const source = `
      fun handleGatewayEvent(event: String, payloadJson: String?) {
        when (event) {
          "tick" -> {
            scope.launch { pollHealth() }
          }
          "chat" -> {
            when (parseKind(payloadJson)) {
              "nested.ignored" -> return
              else -> handleChat(payloadJson)
            }
          }
          "sessions.changed", "session.message" -> refresh()
        }
      }
      if (event == "connect.challenge") { return }
      val other = keyEvent == "not.a.gateway.event"
    `;
    const handled = extractKotlinHandledEvents(source);
    expect([...handled].toSorted()).toEqual([
      "chat",
      "connect.challenge",
      "session.message",
      "sessions.changed",
      "tick",
    ]);
  });
});

describe("compareEventCoverage", () => {
  const serverEvents = ["tick", "chat", "presence", "cron"];

  it("passes when every event is handled or allowlisted", () => {
    const errors = compareEventCoverage({
      client: "ios",
      serverEvents,
      handledEvents: new Set(["tick", "chat", "client.only.synthetic"]),
      allowlist: { presence: "not rendered", cron: "not surfaced" },
    });
    expect(errors).toEqual([]);
  });

  it("reports unhandled events missing from the allowlist", () => {
    const errors = compareEventCoverage({
      client: "android",
      serverEvents,
      handledEvents: new Set(["tick", "chat"]),
      allowlist: { presence: "not rendered" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[android] gateway event "cron"');
  });

  it("reports stale allowlist entries", () => {
    const errors = compareEventCoverage({
      client: "ios",
      serverEvents,
      handledEvents: new Set(["tick", "chat", "presence"]),
      allowlist: {
        presence: "now handled, should be removed",
        "gone.event": "no longer a gateway event",
        cron: "",
      },
    });
    expect(errors.some((error) => error.includes('"presence" is now handled'))).toBe(true);
    expect(errors.some((error) => error.includes('"gone.event" is not a gateway event'))).toBe(
      true,
    );
    expect(errors.some((error) => error.includes('"cron" needs a non-empty reason'))).toBe(true);
  });
});
