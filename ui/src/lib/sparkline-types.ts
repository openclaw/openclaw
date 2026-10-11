export type SparklineSample = {
  value: number;
  at: number;
  secondary?: string;
  stack?: readonly number[];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-sparkline": HTMLAttributes<HTMLElement> & {
        "prop:label": string;
        "prop:sub"?: string;
        "prop:samples": readonly SparklineSample[];
        "prop:format": (value: number) => string;
        "prop:floorMax"?: number;
        "prop:stackColors"?: readonly string[];
        "prop:autorange"?: boolean;
        autorange?: boolean;
      };
    }
  }
}
