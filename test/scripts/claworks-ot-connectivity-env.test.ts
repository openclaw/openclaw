import { describe, expect, it } from "vitest";
import { auditOtConnectorEnv } from "../../scripts/lib/claworks-ot-connectivity-env.mjs";

describe("claworks ot connectivity env", () => {
  it("flags missing mqtt env when simulate is false", () => {
    const findings = auditOtConnectorEnv(
      { plant: { preset: "mqtt", simulate: false, enabled: true } },
      {},
    );
    expect(findings.some((f) => f.message.includes("CLAWORKS_MQTT_URL"))).toBe(true);
  });

  it("passes when live mqtt env is set and simulate env off", () => {
    const findings = auditOtConnectorEnv(
      { plant: { preset: "mqtt", simulate: false, enabled: true } },
      {
        CLAWORKS_MQTT_URL: "mqtt://broker:1883",
        CLAWORKS_MQTT_TOPIC: "alarms/#",
      },
    );
    expect(findings).toHaveLength(0);
  });

  it("flags simulate env conflict in production", () => {
    const findings = auditOtConnectorEnv(
      { opc: { preset: "opcua", simulate: false } },
      {
        CLAWORKS_OPCUA_ENDPOINT: "opc.tcp://127.0.0.1:4840",
        CLAWORKS_OPCUA_SIMULATE: "1",
      },
    );
    expect(findings.some((f) => f.message.includes("CLAWORKS_OPCUA_SIMULATE"))).toBe(true);
  });
});
