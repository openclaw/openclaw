// Defines marketplace feed and package source profile configuration types.
export type MarketplaceFeedVerificationConfig =
  | {
      mode: "unsigned";
    }
  | {
      mode: "signed";
      keys: readonly {
        keyId: string;
        publicKey: string;
      }[];
      threshold?: number;
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
