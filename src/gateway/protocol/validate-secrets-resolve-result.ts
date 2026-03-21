import AjvPkg from "ajv";
import { type SecretsResolveResult, SecretsResolveResultSchema } from "./schema/secrets.js";

// Keep status/startup paths from pulling in the full protocol validator bundle
// when they only need the secrets.resolve result schema.
const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateSecretsResolveResult = ajv.compile<SecretsResolveResult>(
  SecretsResolveResultSchema,
);
