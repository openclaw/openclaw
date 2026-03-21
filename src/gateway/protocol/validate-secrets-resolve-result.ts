import AjvPkg from "ajv";
import { type SecretsResolveResult, SecretsResolveResultSchema } from "./schema/secrets.js";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateSecretsResolveResult = ajv.compile<SecretsResolveResult>(
  SecretsResolveResultSchema,
);
