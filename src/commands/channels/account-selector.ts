import { throwExpectedCliError } from "../../cli/expected-cli-error.js";

export function parseAccountSelector(account: string | undefined): string | undefined {
  // Only omission selects the default account. Blank input often comes from an unset
  // shell variable and must fail before channel setup, auth, removal, or lookup runs.
  if (account !== undefined && !account.trim()) {
    throwExpectedCliError("--account must not be blank");
  }
  return account;
}
