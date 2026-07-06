// Defines marketplace feed and package source profile configuration types.
export type MarketplaceFeedVerificationConfig =
  | {
      mode: "unsigned";
    }
  | {
      mode: "signed";
      keys: readonly MarketplaceFeedTrustedPublicKeyConfig[];
      threshold?: number;
    };

export type MarketplaceFeedTrustedPublicKeyConfig = {
  keyId: string;
  publicKey: string;
};

/** @deprecated Use MarketplaceFeedTrustedPublicKeyConfig. */
export type MarketplaceFeedSigningKeyConfig = MarketplaceFeedTrustedPublicKeyConfig;

export type MarketplaceFeedProfileConfig = {
  url: string;
  verification?: MarketplaceFeedVerificationConfig;
};

export type MarketplaceSourceProfileConfig =
  | {
      type: "npm";
    }
  | {
      type: "clawhub";
    }
  | {
      type: "git";
    };

export type MarketplacesConfig = {
  feeds?: Record<string, MarketplaceFeedProfileConfig>;
  sources?: Record<string, MarketplaceSourceProfileConfig>;
};
