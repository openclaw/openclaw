/\*\*

- OpenClaw i18n Architecture Documentation
-
- @fileoverview
- Comprehensive guide for the internationalization (i18n) system architecture.
- This document covers design decisions, module structure, and integration patterns.
-
- @module i18n/ARCHITECTURE
  \*/

// =============================================================================
// ARCHITECTURE OVERVIEW
// =============================================================================

/\*

-                         OpenClaw i18n Architecture
- ┌─────────────────────────────────────────────────────────────────────────┐
-                                                                         │
- ┌──────────────┐ │
- │ Application │ │
- │ Code │ │
- └──────┬───────┘ │
-          │                                                              │
-          ▼                                                              │
- ┌─────────────────────────────────────────────────────────────┐ │
- │ i18n API Layer │ │
- │ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐ │ │
- │ │ t() │ │ setLocale │ │ getLocale │ │ has() │ │ │
- │ │ │ │ │ │ │ │ │ │ │
- │ │ Translator│ │ Detector │ │ Config │ │ Validator │ │ │
- │ └───────────┘ └───────────┘ └───────────┘ └───────────┘ │ │
- └─────────────────────────┬───────────────────────────────────┘ │
-                             │                                           │
-          ┌──────────────────┼──────────────────┐                        │
-          │                  │                  │                        │
-          ▼                  ▼                  ▼                        │
- ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │
- │ en.json │ │ zh-CN.json │ │ zh-TW.json │ │
- │ (English) │ │ (Simplified│ │ (Traditional│ │
- │ │ │ Chinese) │ │ Chinese) │ │
- └─────────────┘ └─────────────┘ └─────────────┘ │
-                                                                         │
- └─────────────────────────────────────────────────────────────────────────┘
-
- DESIGN PRINCIPLES:
-
- 1.  Lightweight - No heavy dependencies, pure TypeScript implementation
- 2.  Lazy Loading - Translation files loaded only when needed
- 3.  Namespace Organization - Logical grouping of translations
- 4.  Fallback Chain - Graceful degradation when translations missing
- 5.  Runtime Switchable - Language can be changed at runtime
      \*/

// =============================================================================
// MODULE STRUCTURE
// =============================================================================

/\*

- src/i18n/
- ├── index.ts # Main export and public API
- ├── config.ts # Configuration constants
- ├── types.ts # TypeScript type definitions
- ├── detector.ts # Language detection logic
- ├── loader.ts # Translation file loading
- ├── translator.ts # Core translation function
- ├── locales/ # Translation files
- │ ├── en.json # English (source)
- │ ├── zh-CN.json # Chinese (Simplified)
- │ └── zh-TW.json # Chinese (Traditional)
- ├── integration-example.ts # Usage examples
- └── i18n.test.ts # Unit tests
  \*/

// =============================================================================
// TRANSLATION FILE FORMAT
// =============================================================================

/\*

- Translation files use JSON format with namespace-based organization:
-
- {
- "cli": { ... }, // CLI command strings
- "errors": { ... }, // Error messages
- "wizards": { ... }, // Wizard prompts
- "status": { ... }, // Status messages
- "validation": { ... }, // Validation messages
- "common": { ... } // Common UI strings
- }
-
- Example:
- {
- "errors": {
-     "fileNotFound": "File not found: {{file}}",
-     "permissionDenied": "Permission denied"
- }
- }
-
- KEY CONVENTIONS:
- - Keys use dot notation for nesting (e.g., "errors.fileNotFound")
- - Placeholders use double curly braces (e.g., {{file}})
- - All keys are lowercase with underscores for multi-word keys
- - Namespace:key format for accessing translations
    \*/

// =============================================================================
// LANGUAGE DETECTION FLOW
// =============================================================================

/\*

- Language detection follows this priority order:
-
- 1.  Environment Variable
- OPENCLAW_LOCALE=zh-CN pnpm openclaw
-
- 2.  CLI Flag
- pnpm openclaw --lang zh-CN status
-
- 3.  System Locale
- - Checks LC_ALL, LC_MESSAGES, LANG environment variables
- - Falls back to Intl.DateTimeFormat().locale
-
- 4.  Default Fallback
- - English (en) if no other locale detected
- - Configured in DEFAULT_LOCALE constant
    \*/

// =============================================================================
// INTERPOLATION SYSTEM
// =============================================================================

/\*

- The i18n module supports parameter interpolation using Mustache-style syntax:
-
- Translation: "File not found: {{file}}"
- Call: t("errors.fileNotFound", { file: "config.json" })
- Result: "File not found: config.json"
-
- INTERPOLATION FEATURES:
- - Multiple parameters: "{{name}} {{surname}}"
- - Numeric values: Converted to strings automatically
- - Boolean values: "true" or "false"
- - Special characters: Automatically escaped
-
- ADVANCED USAGE:
- const message = t("errors.complex", {
- count: 5,
- item: "files",
- location: "/path/to/dir"
- });
  \*/

// =============================================================================
// RUNTIME LANGUAGE SWITCHING
// =============================================================================

/\*

- Languages can be switched at runtime without restarting:
-
- // Simple global switch
- setLocale("zh-CN");
-
- // Per-instance translator
- const translator = createI18n("zh-TW");
- translator.setLocale("zh-CN");
-
- CAVEATS:
- - String caching may affect immediate updates
- - Some modules cache translations at import time
- - Use createI18n() for isolated translator instances
    \*/

// =============================================================================
// NAMESPACE REFERENCE
// =============================================================================

/\*

- AVAILABLE NAMESPACES:
-
- cli
- Purpose: CLI command descriptions and flags
- Examples: help, version, status, config
-
- errors
- Purpose: Error messages shown to users
- Examples: fileNotFound, permissionDenied, networkError
-
- wizards
- Purpose: Setup wizard and interactive prompts
- Examples: welcomeTitle, selectLanguage, scanQrCode
-
- status
- Purpose: System status and progress messages
- Examples: running, connected, loading
-
- validation
- Purpose: Form input validation messages
- Examples: emailInvalid, minLength, requiredField
-
- common
- Purpose: Frequently used UI strings
- Examples: yes, no, ok, cancel, save
  \*/

// =============================================================================
// CONFIGURATION OPTIONS
// =============================================================================

/\*

- CONFIGURABLE OPTIONS:
-
- fallbackLocale: Locale to use when translation missing
- Default: "en" (English)
-
- warnOnMissing: Log warnings for missing translations
- Default: true (development mode)
-
- interpolation.prefix: Opening placeholder marker
- Default: "{{"
-
- interpolation.suffix: Closing placeholder marker
- Default: "}}"
-
- EXAMPLE:
- const t = createI18n("zh-CN", {
- fallbackLocale: "en",
- warnOnMissing: true,
- interpolation: {
-     prefix: "[[",
-     suffix: "]]"
- }
- });
  \*/

// =============================================================================
// PERFORMANCE CONSIDERATIONS
// =============================================================================

/\*

- PERFORMANCE CHARACTERISTICS:
-
- Translation Loading:
- - Lazy loading: Files loaded on first access
- - In-memory cache: Loaded translations cached globally
- - Singleton pattern: One set of translations per process
-
- Translation Lookup:
- - O(1) key lookup using nested object traversal
- - Namespace caching: Frequent keys can be cached
-
- Memory Usage:
- - Each locale file: ~10-20KB typical
- - 3 locales: ~60KB memory footprint
-
- OPTIMIZATION TIPS:
- - Use has() before t() for optional translations
- - Create dedicated translator for hot paths
- - Avoid dynamic key construction in tight loops
    \*/

// =============================================================================
// TESTING STRATEGY
// =============================================================================

/\*

- TESTING APPROACHES:
-
- 1.  Unit Tests (i18n.test.ts)
- - All translation keys exist
- - Interpolation works correctly
- - Locale switching functions
- - Fallback behavior verified
-
- 2.  Integration Tests
- - CLI commands display correct translations
- - Wizards show translated prompts
- - Error messages are localized
-
- 3.  Manual Testing
- - Visual verification of translated UI
- - Edge case testing with long strings
- - RTL language support (future)
    \*/

// =============================================================================
// EXTENSION POINTS
// =============================================================================

/\*

- EXTENDING THE I18N SYSTEM:
-
- 1.  Adding New Locales
- - Create new locale file in locales/
- - Add to availableLocales in config.ts
- - Update detector mappings
-
- 2.  Custom Interpolation
- - Override interpolation prefix/suffix
- - Implement custom formatter functions
-
- 3.  Pluralization Support
- - Add pluralization logic to translator
- - Define plural rules for each locale
-
- 4.  Context-Aware Translations
- - Add context parameter to t()
- - Implement gender/number agreement
-
- 5.  Translation Validation
- - Add JSON schema validation
- - Check for missing keys
- - Verify placeholder consistency
    \*/

// =============================================================================
// MIGRATION GUIDE
// =============================================================================

/\*

- MIGRATING EXISTING STRINGS TO I18N:
-
- BEFORE:
- function showError(file: string) {
- console.error(`File not found: ${file}`);
- }
-
- AFTER:
- 1.  Add translation to errors namespace in en.json:
- "fileNotFound": "File not found: {{file}}"
-
- 2.  Update function:
- function showError(file: string) {
- console.error(t("errors.fileNotFound", { file }));
- }
-
- MIGRATION CHECKLIST:
- [ ] Identify all hardcoded user-facing strings
- [ ] Group by namespace (errors, cli, etc.)
- [ ] Add to translation files
- [ ] Replace with t() calls
- [ ] Test in all supported languages
- [ ] Document new strings for translators
      \*/

// =============================================================================
// BEST PRACTICES
// =============================================================================

/\*

- CODING STANDARDS:
-
- 1.  Always use translation keys, never hardcode strings
- 2.  Use descriptive keys that indicate context
- 3.  Keep translations concise and clear
- 4.  Use consistent terminology across translations
- 5.  Test with multiple languages
-
- KEY NAMING CONVENTIONS:
- - errors.fileNotFound (not errors.error_file_not_found)
- - status.running (not status.is_running)
- - validation.emailInvalid (not validation.invalid_email_format)
-
- FILE ORGANIZATION:
- - One translation file per locale
- - Namespace grouping within files
- - Consistent key ordering (alphabetical within namespace)
    \*/

// =============================================================================
// TROUBLESHOOTING
// =============================================================================

/\*

- COMMON ISSUES:
-
- 1.  Missing Translations
- Symptom: Shows "[missing translation]" or English fallback
- Solution: Check locale file exists and is valid JSON
-
- 2.  Interpolation Not Working
- Symptom: Placeholders show as {{name}}
- Solution: Ensure parameters are passed and keys match exactly
-
- 3.  Wrong Language Displayed
- Symptom: Wrong locale shown despite setting
- Solution: Check environment variables and CLI flags order
-
- 4.  Changes Not Taking Effect
- Symptom: Old translations still showing
- Solution: Restart application, check import order
-
- DEBUGGING TIPS:
- - Set OPENCLAW_DEBUG=i18n for verbose logging
- - Use has() to verify key existence
- - Check getLocale() returns expected value
    \*/

// =============================================================================
// FUTURE ENHANCEMENTS
// =============================================================================

/\*

- ROADMAP:
-
- Short Term:
- - More locale files (Japanese, Korean)
- - Translation validation tooling
- - In-editor translation lookup
-
- Medium Term:
- - Pluralization support
- - Gender/number agreement
- - Context-aware translations
- - Translation memory integration
-
- Long Term:
- - RTL language support
- - Dynamic locale loading
- - Crowdsourced translations
- - Translation quality scoring
    \*/
