type StateDirEnvSnapshot = {
  EasyHubStateDir: string | undefined;
  clawdbotStateDir: string | undefined;
};

export function snapshotStateDirEnv(): StateDirEnvSnapshot {
  return {
    EasyHubStateDir: process.env.EASYHUB_STATE_DIR,
    clawdbotStateDir: process.env.EASYHUB_STATE_DIR,
  };
}

export function restoreStateDirEnv(snapshot: StateDirEnvSnapshot): void {
  if (snapshot.EasyHubStateDir === undefined) {
    delete process.env.EASYHUB_STATE_DIR;
  } else {
    process.env.EASYHUB_STATE_DIR = snapshot.EasyHubStateDir;
  }
  if (snapshot.clawdbotStateDir === undefined) {
    delete process.env.EASYHUB_STATE_DIR;
  } else {
    process.env.EASYHUB_STATE_DIR = snapshot.clawdbotStateDir;
  }
}

export function setStateDirEnv(stateDir: string): void {
  process.env.EASYHUB_STATE_DIR = stateDir;
  delete process.env.EASYHUB_STATE_DIR;
}
