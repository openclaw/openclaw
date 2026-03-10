# Control UI i18n

This folder contains translations for the OpenClaw dashboard UI.

## File layout

- `locales/en.ts`: English source of truth.
- `locales/<locale>.ts`: locale translations loaded at runtime.
- `lib/registry.ts`: supported locale list + lazy-load mapping.
- `lib/types.ts`: locale type union.

## Add or update a translation

1. Copy keys from `locales/en.ts` and translate values in your locale file.
2. Run `pnpm ui:i18n:report` to see missing or extra keys.
3. For Chinese (Simplified) parity gate, run `pnpm ui:i18n:check:zh-CN`.

## Add a new locale

1. Add `ui/src/i18n/locales/<locale>.ts`.
2. Add the locale to `Locale` in `ui/src/i18n/lib/types.ts`.
3. Register lazy loading in `ui/src/i18n/lib/registry.ts`.
4. Add a display name under `languages.*` in `locales/en.ts` (and optionally in other locales).
5. Run `pnpm ui:i18n:report -- --locale <locale>`.

## Notes

- Missing keys fall back to English.
- Keep keys stable; do not rename keys unless all locales are updated.
