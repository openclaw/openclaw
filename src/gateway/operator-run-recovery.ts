import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { restoreOperatorModelPolicySnapshot } from "../agents/operator-model-policy.js";
import { prepareCommandOwnerAuthority } from "../auto-reply/command-auth.js";
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
