export type SetupSurfaceSection = "providers" | "channels";

export type SetupSurfaceFieldKind = "secret" | "text";

export type SetupSurfaceFieldDescriptor = {
  kind: SetupSurfaceFieldKind;
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  preferredEnvVar?: string;
  providerHint?: string;
  message?: string;
  helpTitle?: string;
  helpLines?: string[];
};

export type SetupSurfaceStatusDescriptor = {
  configured: boolean;
  lines: string[];
  selectionHint?: string;
  quickstartScore?: number;
};

export type SetupSurfaceProviderMethodDescriptor = {
  id: string;
  label: string;
  kind: string;
  hint?: string;
  choiceId?: string;
  choiceLabel?: string;
  choiceHint?: string;
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  onboardingScopes?: Array<"text-inference" | "image-generation">;
  surface?: {
    kind: "api_key";
    optionKey: string;
    flagName: string;
    envVar: string;
    allowProfile?: boolean;
    defaultModel?: string;
  };
};

export type SetupSurfaceProviderEntry = {
  kind: "provider";
  id: string;
  pluginId?: string;
  label: string;
  docsPath?: string;
  envVars: string[];
  aliases: string[];
  methods: SetupSurfaceProviderMethodDescriptor[];
  modelPicker?: {
    label?: string;
    hint?: string;
    methodId?: string;
  };
};

export type SetupSurfaceChannelEntry = {
  kind: "channel";
  id: string;
  pluginId?: string;
  installed: boolean;
  installable: boolean;
  label: string;
  selectionLabel: string;
  detailLabel?: string;
  docsPath?: string;
  blurb?: string;
  systemImage?: string;
  aliases: string[];
  status: SetupSurfaceStatusDescriptor;
  features: {
    envShortcut: boolean;
    allowFrom: boolean;
    groupAccess: boolean;
    dmPolicy: boolean;
    multipleAccounts: boolean;
    disableSupported: boolean;
  };
  stepOrder?: "credentials-first" | "text-first";
  fields: SetupSurfaceFieldDescriptor[];
};

export type SetupSurfaceDocument = {
  version: 1;
  generatedAt: string;
  sections: SetupSurfaceSection[];
  providers: SetupSurfaceProviderEntry[];
  channels: SetupSurfaceChannelEntry[];
};
