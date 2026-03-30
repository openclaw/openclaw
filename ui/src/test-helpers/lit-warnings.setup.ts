// Lit emits a one-time dev-mode warning in test builds. Pre-mark it as issued
// so broad UI suites stay signal-heavy instead of repeating the same console.warn.
const issuedWarnings = ((
	globalThis as { litIssuedWarnings?: Set<string> }
).litIssuedWarnings ??= new Set<string>());

issuedWarnings.add("dev-mode");
