import { expect, it } from "vitest";
import { readUpdateRepairMaintenanceRequest } from "./update-repair-maintenance.js";

it.each(["doctor-fix", "update-repair"] as const)("reads one typed %s request", (operation) => {
  expect(
    readUpdateRepairMaintenanceRequest({
      stopReason: "tool_calls",
      pendingToolCalls: [
        { name: "request_update_maintenance", arguments: JSON.stringify({ operation }) },
      ],
    }),
  ).toEqual({ operation });
});

it.each([
  {
    stopReason: "stop",
    pendingToolCalls: [
      { name: "request_update_maintenance", arguments: '{"operation":"doctor-fix"}' },
    ],
  },
  {
    stopReason: "tool_calls",
    pendingToolCalls: [{ name: "exec", arguments: '{"operation":"doctor-fix"}' }],
  },
  {
    stopReason: "tool_calls",
    pendingToolCalls: [
      {
        name: "request_update_maintenance",
        arguments: '{"operation":"doctor-fix","command":"anything"}',
      },
    ],
  },
  {
    stopReason: "tool_calls",
    pendingToolCalls: [
      { name: "request_update_maintenance", arguments: '{"operation":"doctor-fix"}' },
      { name: "request_update_maintenance", arguments: '{"operation":"update-repair"}' },
    ],
  },
])("refuses malformed or ambiguous terminal maintenance requests: %j", (meta) => {
  expect(() => readUpdateRepairMaintenanceRequest(meta)).toThrow();
});
