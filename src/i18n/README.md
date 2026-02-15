# OpenClaw i18n (Internationalization)

Lightweight localization system for OpenClaw.

## Structure

```
src/i18n/
├── index.ts    — runtime: setLocale(), t(), getLocale()
├── en.json     — English (default / fallback)
├── uk.json     — Ukrainian
└── README.md
```

## Usage

```ts
import { setLocale, t } from "./i18n";

setLocale("uk");
console.log(t("commands.help.description")); // "Допомога та команди."
console.log(t("system.model_changed", { model: "gpt-4" })); // "Модель змінено на gpt-4."
```

## Adding a new locale

1. Copy `en.json` → `{code}.json`
2. Translate all values
3. Import in `index.ts` and add to the `locales` map
4. Add the code to the `Locale` type union

## Key namespaces

- `commands.*` — command descriptions shown in /help and /commands
- `system.*` — system messages (errors, confirmations, status)
