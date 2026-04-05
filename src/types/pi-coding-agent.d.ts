import "@mariozechner/pi-coding-agent";

declare module "@mariozechner/pi-coding-agent" {
  interface Skill {
    // Mullusi relies on the source identifier returned by pi skill loaders.
    source: string;
  }
}
