import "@solidjs/web";

// The remaining custom elements own their children and behavior during the page cutover.
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-plugin-manager": HTMLAttributes<HTMLElement>;
      "openclaw-plugin-catalog-skeleton": HTMLAttributes<HTMLElement>;
      "openclaw-plugin-settings-editor": HTMLAttributes<HTMLElement>;
      "openclaw-plugin-credential-editor": HTMLAttributes<HTMLElement>;
    }
  }
}
