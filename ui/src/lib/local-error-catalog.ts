import { registerLocalErrorsEnglish } from "../i18n/locales/en-local-errors.ts";
import { registerEnglishCatalog } from "./reactive/i18n.ts";

registerEnglishCatalog(registerLocalErrorsEnglish);

export { t } from "../i18n/index.ts";
