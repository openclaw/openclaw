// Real transport -> accepted queue custody -> saved-source admission. No authority is manufactured.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TurnGrant } from "../agents/admitted-run-operator-authority.types.js";
import type { LiveAdmissionKind, Mode, Row } from "./operator-admission.contracts.test-support.js";
import { createFixture, runCase } from "./operator-admission.fixture.test-support.js";
import type { AdmissionFixture } from "./operator-admission.table.test-support.js";
import type {
  OperatorRunRecoverySnapshot,
  QueuedOperatorRecoverySource,
} from "./operator-run-recovery-source.codec.js";

type HandshakeSnapshot = Exclude<OperatorRunRecoverySnapshot, { sourceIngress: "principal" }>;
type AuthMethod = HandshakeSnapshot["authPolicy"]["authMethod"];
type Ingress = HandshakeSnapshot["sourceIngress"];
// resolveConnectAuthState uses the WS auth surface for every WS client, including internal clients.
type WsKind = `${AuthMethod}:${Ingress}`;
type Kind =
  | WsKind
  | `fallback:${Ingress}`
  | `proxy-device:${Ingress}`
  | `tailscale-device:${Ingress}`
  | "ocid-owner"
  | "ocid-member"
  | "plugin-grant"
  | Exclude<OperatorRunRecoverySnapshot["sourceIngress"], Ingress>
  | LiveAdmissionKind
  // A saved channel owner has no socket handshake to replay; owed-exec-requester.test.ts has its cells.
  | Exclude<QueuedOperatorRecoverySource["kind"], "gateway" | "unavailable" | "channel-owner">;
const rows: Record<Kind, Row> = {
  "token:control-ui": { credential: "token", ingress: "control-ui" },
  "token:internal": { credential: "token", ingress: "internal" },
  "password:control-ui": { credential: "password", ingress: "control-ui" },
  "password:internal": { credential: "password", ingress: "internal" },
  "device-token:control-ui": { credential: "device-token", ingress: "control-ui" },
  "device-token:internal": { credential: "device-token", ingress: "internal" },
  "tailscale:control-ui": { credential: "tailscale", ingress: "control-ui" },
  "tailscale:internal": { credential: "tailscale", ingress: "internal" },
  "tailscale-device:control-ui": { credential: "tailscale-device", ingress: "control-ui" },
  "tailscale-device:internal": { credential: "tailscale-device", ingress: "internal" },
  "trusted-proxy:control-ui": { credential: "trusted-proxy", ingress: "control-ui" },
  "trusted-proxy:internal": { credential: "trusted-proxy", ingress: "internal" },
  "fallback:control-ui": { credential: "fallback", ingress: "control-ui" },
  "fallback:internal": { credential: "fallback", ingress: "internal" },
  "proxy-device:control-ui": { credential: "proxy-device", ingress: "control-ui" },
  "proxy-device:internal": { credential: "proxy-device", ingress: "internal" },
  "ocid-owner": { credential: "ocid-owner", ingress: "control-ui" },
  "ocid-member": { credential: "ocid-member", ingress: "control-ui" },
  principal: { credential: "principal", ingress: "principal" },
  channel: { credential: "channel", ingress: "channel" },
  "plugin-grant": { credential: "plugin-grant", ingress: "internal" },
  "http-bearer": { credential: "http-bearer", ingress: "live" },
  "http-ocid": { credential: "http-ocid", ingress: "live" },
  "openai-compatible": { credential: "openai-compatible", ingress: "live" },
  "plugin-in-process": { credential: "plugin-in-process", ingress: "live" },
  "recorded-person": { credential: "recorded-person", ingress: "live" },
  "recorded-system-turn": { credential: "recorded-system-turn", ingress: "live" },
  "cron-standing-grant": { credential: "cron-standing-grant", ingress: "live" },
  "cron-management-grant": { credential: "cron-management-grant", ingress: "live" },
  "cron-operator-source": { credential: "cron-operator-source", ingress: "live" },
  "live-device": { credential: "live-device", ingress: "live" },
  "live-proxy": { credential: "live-proxy", ingress: "live" },
  "live-ingress": { credential: "live-ingress", ingress: "live" },
  "live-remote-ingress": { credential: "live-remote-ingress", ingress: "live" },
  "live-grant": { credential: "live-grant", ingress: "live" },
  "live-role": { credential: "live-role", ingress: "live" },
  "live-token": { credential: "live-token", ingress: "live" },
  "live-fallback": { credential: "live-fallback", ingress: "live" },
  "live-device-revoked": { credential: "live-device-revoked", ingress: "live" },
  "live-device-key-changed": { credential: "live-device-key-changed", ingress: "live" },
};

const modeFor = (row: Row): Mode =>
  [
    "trusted-proxy",
    "plugin-grant",
    "proxy-device",
    "fallback",
    "live-device",
    "live-proxy",
    "live-grant",
    "live-role",
    "live-fallback",
    "live-device-revoked",
    "live-device-key-changed",
  ].includes(row.credential)
    ? "trusted-proxy"
    : row.credential === "password"
      ? "password"
      : "token";

// Turn grant matrix: same principal, same answer. Each `after-start` row below also checks the
// grant at fresh admission (accepted input) and at saved-source replay admission. OWNER is the
// installation owner (shared secret, OpenClaw ID owner) and PERSON is operator@example.test; the
// harness admits both with operator.read + operator.write over a socket. A linked channel sender
// gets its profile's Control UI grant. An HTTP shared-secret request names the same owner with
// the documented HTTP scope set (operator.admin included), so it gets the owner's full grant.
// Durable exec wakes (requester x session principal, configured channel owner) have their cells
// in owed-exec-requester.test.ts. Cron runs and subagent completion join with the PRs that move
// them.
const WRITER_GRANT: TurnGrant = {
  owner: false,
  automations: "self",
  skillAuthoring: true,
  questionReplace: true,
  commands: "none",
};
const OWNER_GRANT: TurnGrant = {
  owner: true,
  automations: "manage",
  skillAuthoring: true,
  questionReplace: true,
  commands: "all",
};
const MATRIX: Partial<Record<Kind, ["OWNER" | "PERSON", TurnGrant]>> = {
  "token:control-ui": ["OWNER", WRITER_GRANT],
  "password:control-ui": ["OWNER", WRITER_GRANT],
  "ocid-owner": ["OWNER", WRITER_GRANT],
  "token:internal": ["OWNER", WRITER_GRANT],
  "http-bearer": ["OWNER", OWNER_GRANT],
  "tailscale:control-ui": ["PERSON", WRITER_GRANT],
  "tailscale-device:control-ui": ["PERSON", WRITER_GRANT],
  "trusted-proxy:control-ui": ["PERSON", WRITER_GRANT],
  channel: ["PERSON", WRITER_GRANT],
};
// Discord senders: a verified `commands.ownerAllowFrom` sender is the owner principal, with the
// owner's full grant, also when linked to a non-admin profile (listed owner wins); an allowlisted
// non-owner (guest) gets no operator grant.
const CHANNEL_SENDER_GRANT: Record<string, TurnGrant | undefined> = {
  "owner-revoked-before-start": OWNER_GRANT,
  "listed-linked-owner": OWNER_GRANT,
  "mixed-owner-group": undefined,
};

// Auth-mode transitions require a real Gateway restart (config-reload-plan.ts).
// Three shared mode owners plus two restart sentinels cover all rows with five boots.
describe.each(["token", "password", "trusted-proxy"] as const)("saved admission: %s", (mode) => {
  let fixture: AdmissionFixture;
  beforeAll(async () => {
    fixture = await createFixture(mode);
  }, 90_000);
  afterAll(async () => {
    await fixture?.close();
  });
  if (mode === "trusted-proxy") {
    it.for([
      ["fallback:internal", "legacy-method-disabled"],
      ["fallback:internal", "legacy-fallback"],
      ["fallback:internal", "legacy-rotated"],
      ["fallback:internal", "fallback-proxy-policy"],
      ["trusted-proxy:internal", "narrowed-grant"],
      ["trusted-proxy:internal", "widened-grant"],
      ["trusted-proxy:internal", "narrowed-role"],
      ["trusted-proxy:internal", "empty-after-role"],
      ["trusted-proxy:control-ui", "goal-agent-excluded"],
      ["live-proxy", "secondary-email-removed"],
      ["live-proxy", "profile-deleted"],
      ["plugin-grant", "plugin-resume-mismatch"],
      ["plugin-grant", "plugin-authorize-denied"],
      ["plugin-grant", "plugin-authorize-allowed"],
      ["plugin-grant", "plugin-owner-unavailable"],
    ] as const)("%s: %s", { timeout: 90_000 }, async ([kind, scenario], { signal }) => {
      await runCase(fixture, rows[kind], scenario, signal);
    });
  }
  if (mode === "token") {
    it.for([
      ["ocid-owner", "owner-unavailable"],
      ["ocid-member", "live-ocid-grant"],
      ["token:internal", "generation-unavailable"],
      ["device-token:internal", "narrowed-token"],
      ["principal", "narrowed-ingress"],
      ["tailscale-device:internal", "device-token-revoked"],
      ["tailscale-device:internal", "device-role-unapproved"],
      ["device-token:internal", "pairing-unavailable"],
      ["tailscale:internal", "legacy-tailscale"],
      ["tailscale:internal", "legacy-tailscale-narrowed"],
      ["tailscale-device:internal", "narrowed-grant"],
      ["tailscale-device:internal", "widened-grant"],
      ["channel", "mixed-owner-group"],
      ["channel", "owner-revoked-before-start"],
      ["channel", "listed-linked-owner"],
    ] as const)("%s: %s", { timeout: 90_000 }, async ([kind, scenario], { signal }) => {
      const c = await runCase(fixture, rows[kind], scenario, signal);
      if (scenario in CHANNEL_SENDER_GRANT) {
        expect(c.original?.operatorAuthority?.grant, `channel sender x ${scenario}`).toEqual(
          CHANNEL_SENDER_GRANT[scenario],
        );
      }
    });
  }
  describe.each(Object.entries(rows).filter(([, row]) => modeFor(row) === mode))(
    "%s",
    (kind, row) => {
      for (const scenario of ["before-start", "after-start", "stop"] as const) {
        it(scenario, { timeout: 90_000 }, async ({ signal }) => {
          const c = await runCase(fixture, row, scenario, signal);
          const cell = MATRIX[kind as Kind];
          if (scenario === "after-start" && cell) {
            expect(
              { fresh: c.original?.operatorAuthority?.grant, replay: c.replayGrants },
              `${cell[0]} x ${kind}`,
            ).toEqual({ fresh: cell[1], replay: [cell[1]] });
          }
        });
      }
    },
  );
  if (mode === "token") {
    it(
      "refuses a disabled OCID owner after a real restart",
      { timeout: 90_000 },
      async ({ signal }) => {
        await runCase(fixture, rows["ocid-owner"], "owner-disabled", signal, true);
      },
    );
  }
  if (mode === "trusted-proxy") {
    // Last case: keep the transitioned listener until this pool closes, never hot-reset its mode.
    it(
      "refuses a disabled proxy method after replaying accepted input through a real token-mode restart",
      { timeout: 90_000 },
      async ({ signal }) => {
        await runCase(fixture, rows["trusted-proxy:internal"], "method-disabled", signal, true);
      },
    );
  }
});
