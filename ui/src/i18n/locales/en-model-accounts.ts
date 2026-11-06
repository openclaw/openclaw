import type { TranslationMap } from "../lib/types.ts";
import { registerModelAccountListEnglish } from "./en-model-account-list.ts";
import { en } from "./en.ts";

const accountList = registerModelAccountListEnglish.catalog.profilePage.modelAccounts;
const enModelAccounts = {
  profilePage: {
    modelAccounts: {
      title: "Saved accounts",
      addAccount: "Add account",
      provider: "Provider",
      method: "Sign-in method",
      noMethods: "No personal sign-in methods are available. Ask your admin for help.",
      gateway: "Gateway",
      gatewayUnavailable: "Endpoint unavailable",
      person: "Person",
      currentPerson: "Current person",
      noPerson: "Not identified",
      personalDescription:
        "Sign-in saves an account for this person on this Gateway. Shared and agent accounts stay unchanged.",
      enrollmentUnavailable:
        "This connection cannot add credentials. You can still use saved accounts or clear a new-chat default. To add an account, ask your administrator for credential enrollment access and reconnect.",
      signInUnavailable: "Sign-in unavailable",
      connectionSettings: "Connection settings",
      unavailable: {
        identity:
          "Use the identity-enabled Gateway address from your admin, through Tailscale Serve or a trusted proxy. A shared token or device pairing alone doesn’t identify you.",
        write:
          "This connection doesn’t have permission to add accounts. Ask your admin for access, then reconnect to the Gateway.",
        profile: "Your profile hasn’t loaded yet. Use Refresh or Set identity above to try again.",
        disconnected: "Reconnect to the Gateway to add or change accounts.",
      },
      description: "Choose the default account for new sessions.",
      descriptionMore:
        "Existing sessions keep their account choice. Shared fallback rules still apply; this preference isn’t a billing guarantee.",
      empty: "No personal default selected. New sessions use the shared default account.",
      linkedStatus: "New session default",
      gatewayAccount: "Account",
      savedAccounts: "Saved accounts",
      loadMore: accountList.loadMore,
      inventoryFailed: accountList.inventoryFailed,
      authTypes: {
        oauth: "Browser sign-in · saved account",
        token: "Token · saved account",
        api_key: "API key · saved account",
      },
      checkStatusAction: "Check status",
      actionFailed: "Couldn’t update saved accounts. Try again.",
      signInFailed: "Couldn’t finish sign-in. Try again.",
      statusFailed: "Couldn’t check sign-in status. Check again or cancel this attempt.",
      statusTimedOut: "Sign-in hasn’t finished. Check its status or cancel and sign in again.",
      notices: {
        connected: "Account added.",
        cancelled: "Sign-in canceled. This attempt didn’t add an account.",
        expired: "Sign-in expired. Sign in again to start a new attempt.",
        selected: "Default updated for new sessions. Existing sessions are unchanged.",
        cleared:
          "New sessions use the shared default for this provider. Saved accounts and existing sessions are unchanged.",
      },
      connectErrors: {
        exchange: "Couldn’t finish sign-in while exchanging the authorization code. Sign in again.",
        identity: "Couldn’t verify the account identity. Sign in again with your own account.",
        authority:
          "Couldn’t finish sign-in because your access changed. Reconnect to the Gateway and try again.",
        unavailable: "Couldn’t save the account. Sign in again or ask your admin for help.",
      },
      inputLabel: "Use an existing shared account",
      inputDescription:
        "Admin only: choose an existing shared account for this person’s new sessions. This doesn’t sign in or change the saved account.",
      inputPlaceholder: "openai:alice",
      linkAction: "Use for new sessions",
      unlinkAction: "Use shared default",
      connectAction: "Sign in",
      cancelAction: "Cancel",
    },
  },
} satisfies TranslationMap;

export const registerModelAccountsEnglish = Object.assign(
  () => {
    // Account surfaces load this copy lazily; shared profile navigation stays eager.
    en.profilePage = Object.assign({}, en.profilePage, enModelAccounts.profilePage);
  },
  { catalog: enModelAccounts },
);
