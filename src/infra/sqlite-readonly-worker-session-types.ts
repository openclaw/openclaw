import type { SpawnBrokerHost } from "../process/spawn-broker/host.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import type {
  SqliteReadOnlyWorkerOptions,
  SqliteReadOnlyWorkerValue,
} from "./sqlite-readonly-worker-protocol.js";

export type SqliteReadOnlyWorkerLaunch = {
  runtimeGeneration?: RuntimeWorkerGeneration;
  env: NodeJS.ProcessEnv;
  cwd: string;
  transport: { kind: "native" } | { kind: "broker"; owner: SpawnBrokerHost };
};

export type SqliteReadOnlyWorkerSession = {
  readonly closed: Promise<void>;
  readonly notStarted: boolean;
  createNativeReplacement: () => SqliteReadOnlyWorkerSession;
  isRetired: () => boolean;
  compatible: (launch: SqliteReadOnlyWorkerLaunch) => boolean;
  run: (
    pathname: string,
    options: SqliteReadOnlyWorkerOptions,
  ) => Promise<SqliteReadOnlyWorkerValue>;
  setIdle: (idle: boolean) => void;
  close: () => Promise<void>;
};
