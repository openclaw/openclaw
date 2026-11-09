import { encodeOPSaveRequest } from "@1password/save-button";

/**
 * Calls the documented JavaScript API with supported literal autocomplete values.
 * The package ships an ambient const enum but no runtime enum, so its TypeScript
 * entry cannot be used with isolated modules. The adjacent declaration types this
 * narrow boundary without casts, compiler changes or vendor patches.
 *
 * @param {{ title: string; username: string; code: string; notes: string; url: string }} payload
 * @returns {string | undefined}
 */
export function encodeOnePasswordKit(payload) {
  return encodeOPSaveRequest({
    title: payload.title,
    fields: [
      { autocomplete: "username", value: payload.username },
      { autocomplete: "new-password", value: payload.code },
    ],
    notes: payload.notes,
    urls: [payload.url],
  });
}
