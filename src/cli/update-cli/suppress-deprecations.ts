export function suppressDeprecations(): void {
  try {
    process.noDeprecation = true;
  } catch {
    // read-only on Node v23+; NODE_NO_WARNINGS below covers this case
  }
  process.env.NODE_NO_WARNINGS = "1";
}
