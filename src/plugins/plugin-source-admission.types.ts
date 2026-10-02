export type PluginNativeArtifactFact = {
  sourceIdentity: string;
  contentHash: string;
  sizeBytes: number;
  capturedPath: string;
  namespace: string;
  capturedIdentity: string;
};

export type PluginNativeNamespaceFact = {
  sourceDirectory: string;
  capturedRoot: string;
  managed: boolean;
  /** Original immutable npm directory, retained by the install-generation owner. */
  referenceRoot?: string;
  members: Record<
    string,
    {
      source: string;
      sourceIdentity: string;
      capturedIdentity: string;
      boundaryChecked: boolean;
      contentHash?: string;
      sizeBytes?: number;
    }
  >;
};

export type PluginSourceAdmissionReceipt = {
  signature: string;
  sourceDigest: string;
  nativeArtifacts: Record<string, PluginNativeArtifactFact>;
  nativeNamespaces: Record<string, PluginNativeNamespaceFact>;
};

export type PluginSourceAdmissionPublication = {
  pluginId: string;
  rootDir: string;
  installRecordHash?: string;
  key: string;
  receipt: PluginSourceAdmissionReceipt;
};
