// Real transport -> accepted queue custody -> saved-source admission. No authority is manufactured.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  createFixture,
  type AdmissionFixture,
  type Mode,
  type Row,
} from "./operator-admission.table.test-support.js";
import type {
  OperatorRunRecoverySnapshot,
  QueuedOperatorRecoverySource,
} from "./operator-run-recovery-source.codec.js";

type HandshakeSnapshot = Exclude<OperatorRunRecoverySnapshot, { sourceIngress: "principal" }>;
type AuthMethod = HandshakeSnapshot["authPolicy"]["authMethod"];
type Ingress = HandshakeSnapshot["sourceIngress"];
// resolveConnectAuthState uses the WS auth surface for every WS client, including internal clients.
const ingresses = {
  token: ["control-ui", "internal"],
  password: ["control-ui", "internal"],
  "device-token": ["control-ui", "internal"],
  tailscale: ["control-ui", "internal"],
  "trusted-proxy": ["control-ui", "internal"],
} as const satisfies Record<AuthMethod, readonly Ingress[]>;
const sourceIngresses = { "control-ui": true, internal: true, principal: true } satisfies Record<
  OperatorRunRecoverySnapshot["sourceIngress"],
  true
>;
type WsKind = {
  [Method in AuthMethod]: `${Method}:${(typeof ingresses)[Method][number]}`;
}[AuthMethod];
type Kind =
  | WsKind
  | `fallback:${Ingress}`
  | `proxy-device:${Ingress}`
  | "ocid-owner"
  | "ocid-member"
  | Exclude<keyof typeof sourceIngresses, Ingress>
  | Exclude<QueuedOperatorRecoverySource["kind"], "gateway" | "unavailable">;
const rows: Record<Kind, Row> = {
  "token:control-ui": { credential: "token", ingress: "control-ui" },
  "token:internal": { credential: "token", ingress: "internal" },
  "password:control-ui": { credential: "password", ingress: "control-ui" },
  "password:internal": { credential: "password", ingress: "internal" },
  "device-token:control-ui": { credential: "device-token", ingress: "control-ui" },
  "device-token:internal": { credential: "device-token", ingress: "internal" },
  "tailscale:control-ui": { credential: "tailscale", ingress: "control-ui" },
  "tailscale:internal": { credential: "tailscale", ingress: "internal" },
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
};

const modeFor = (row: Row): Mode =>
  ["trusted-proxy", "proxy-device", "fallback"].includes(row.credential)
    ? "trusted-proxy"
    : row.credential === "password"
      ? "password"
      : "token";

// Auth-mode transitions require a real Gateway restart (config-reload-plan.ts).
// Three shared mode owners plus one restart sentinel cover all rows with four boots.
describe.each(["token", "password", "trusted-proxy"] as const)("saved admission: %s", (mode) => {
  let fixture: AdmissionFixture;
  beforeAll(async () => {
    fixture = await createFixture(mode);
  }, 90_000);
  afterAll(async () => {
    await fixture?.close();
  });
  if (mode === "token") {
    it(
      "replays genuinely accepted queued input through a real restart",
      { timeout: 90_000 },
      async ({ signal }) => {
        await fixture.run(rows["token:internal"], "before-start", signal, true);
      },
    );
  }
  describe.each(Object.entries(rows).filter(([, row]) => modeFor(row) === mode))(
    "%s",
    (_kind, row) => {
      for (const scenario of ["before-start", "after-start", "stop"] as const) {
        it(scenario, { timeout: 90_000 }, async ({ signal }) => {
          await fixture.run(row, scenario, signal);
        });
      }
    },
  );
});
