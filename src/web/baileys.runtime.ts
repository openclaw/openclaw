// Runtime boundary for @whiskeysockets/baileys (optional dependency).
// All files in src/web/ that need baileys at runtime import from here,
// not directly from @whiskeysockets/baileys. This keeps the optional-dep
// import surface in one place and lets the dynamic-import chain in
// runtime-whatsapp.ts catch and surface a helpful error when baileys
// is not installed.
export * from "@whiskeysockets/baileys";
