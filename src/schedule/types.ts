export type ScheduleJob = {
  id: string;
  description?: string;
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleFile = {
  version: 1;
  jobs: ScheduleJob[];
};

export type ScheduleRunRecord = {
  ts: string;
  jobId: string;
  cmd: string;
  args: string[];
  cwd?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  error?: string;
};
