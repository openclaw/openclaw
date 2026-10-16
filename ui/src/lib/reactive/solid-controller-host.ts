export type SolidController = {
  hostConnected?(): void;
  hostDisconnected?(): void;
  hostUpdate?(): void;
  hostUpdated?(): void;
};

export type SolidControllerHost = {
  addController(controller: SolidController): void;
  removeController(controller: SolidController): void;
  requestUpdate(): void;
  readonly updateComplete: Promise<boolean>;
};
