// Lifecycle reset hook registry. Plugins may register a synchronous cleanup
// callback that the gateway run-loop drains at the in-process restart
// boundary (SIGUSR1 / OPENCLAW_NO_RESPAWN reload). See `in-process-restart-hooks`
// docs and openclaw/openclaw#81507 for context.

export {
  registerInProcessRestartHook,
  runInProcessRestartHooks,
  clearInProcessRestartHooksForTests,
} from "../infra/in-process-restart-hooks.js";
