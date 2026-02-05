import fs from "node:fs/promises";
import path from "node:path";

export type NeuronWavesState = {
  /** Next time the runner should attempt a wave. */
  nextRunAtMs: number;
};

export const DEFAULT_STATE: NeuronWavesState = {
  nextRunAtMs: 0,
};

export function resolveNeuronWavesDir(workspaceDir: string) {
  return path.join(workspaceDir, ".openclaw", "neuronwaves");
}

export function resolveNeuronWavesStatePath(workspaceDir: string) {
  return path.join(resolveNeuronWavesDir(workspaceDir), "state.json");
}

export function resolveNeuronWavesLogDir(workspaceDir: string) {
  return path.join(resolveNeuronWavesDir(workspaceDir), "logs");
}

export async function loadNeuronWavesState(workspaceDir: string): Promise<NeuronWavesState> {
  const statePath = resolveNeuronWavesStatePath(workspaceDir);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<NeuronWavesState>;
    if (typeof parsed.nextRunAtMs === "number" && Number.isFinite(parsed.nextRunAtMs)) {
      return { nextRunAtMs: parsed.nextRunAtMs };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_STATE };
}

export async function saveNeuronWavesState(workspaceDir: string, state: NeuronWavesState) {
  const dir = resolveNeuronWavesDir(workspaceDir);
  await fs.mkdir(dir, { recursive: true });
  const statePath = resolveNeuronWavesStatePath(workspaceDir);
  const tmp = `${statePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, statePath);
}

export async function appendNeuronWaveTrace(workspaceDir: string, entry: unknown) {
  const logDir = resolveNeuronWavesLogDir(workspaceDir);
  await fs.mkdir(logDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const logPath = path.join(logDir, `${day}.jsonl`);
  await fs.appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
}
