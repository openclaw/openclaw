import type { SystemdServiceReadBinding } from "../daemon/service-types.js";

export function stoppedSystemdBinding(onPassiveRead: () => void): SystemdServiceReadBinding {
  const unit = "openclaw-gateway.service";
  const unitPath = "/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice";
  const properties: Record<string, unknown> = {
    Id: unit,
    LoadState: "loaded",
    ActiveState: "inactive",
    SubState: "dead",
    StartLimitBurst: 5,
    ActiveEnterTimestampMonotonic: 100,
    InactiveEnterTimestampMonotonic: 200,
    Result: "success",
    NRestarts: 0,
    MainPID: 0,
    ExecMainStatus: 0,
    ExecMainCode: 1,
    KillMode: "control-group",
    TasksCurrent: Number("18446744073709551615"),
    MemoryCurrent: 0,
  };
  return {
    unit,
    managerUid: 2001,
    destination: ":1.42",
    verify() {},
    async close() {},
    async query(args, _signatures, _deadline, inspection) {
      if (args[0] === "call") {
        if (args[4] === "LoadUnit" || args[4] === "GetUnit") {
          return [[unitPath]];
        }
        if (args[4] === "GetProcesses") {
          return [[[]]];
        }
      } else if (args[0] === "get-property") {
        const assertRead = inspection?.assertReadCurrent ?? inspection?.assertCurrent;
        // The native peer checks custody around each individual property read.
        return args.slice(4).map((name) => {
          assertRead?.();
          onPassiveRead();
          if (!Object.hasOwn(properties, name)) {
            throw new Error(`Unexpected systemd property: ${name}`);
          }
          assertRead?.();
          return properties[name];
        });
      }
      throw new Error(`Unexpected systemd query: ${args.join(" ")}`);
    },
  };
}
