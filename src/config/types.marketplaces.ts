// Defines marketplace feed and package source profile configuration types.
export type MarketplaceFeedVerificationConfig =
  | {
      mode: "unsigned";
    }
  | {
      mode: "signed";
      keys: readonly MarketplaceFeedSigningKeyConfig[];
      threshold?: number;
    };

export type MarketplaceFeedSigningKeyConfig = {
  keyId: string;
  publicKey: string;
};

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
