import { writePrivateTextFileAtomicSync } from "../infra/private-file-store.js";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import type { TtsPreferenceWrite } from "./tts-settings-write-worker.js";
import { normalizeTtsPersonaId, readTtsPrefs } from "./tts-settings.js";

serveWorkerTasks<void, TtsPreferenceWrite>(({ prefsPath, stateDir, patch }) => {
  const prefs = readTtsPrefs(prefsPath, { forUpdate: true });
  const tts = { ...prefs.tts, ...patch };
  if (patch.auto !== undefined) {
    delete tts.enabled;
  }
  if (Object.hasOwn(patch, "persona")) {
    tts.persona = normalizeTtsPersonaId(patch.persona) ?? null;
  }
  prefs.tts = tts;
  writePrivateTextFileAtomicSync(prefsPath, JSON.stringify(prefs, null, 2), stateDir);
});
