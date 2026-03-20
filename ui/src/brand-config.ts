export interface BrandConfig {
  name: string;
  controlTitle: string;
  logos: {
    favicon: string;
    appleTouchIcon: string;
    logo: string;
  };
}

export const brandConfig: BrandConfig = {
  name: "JSClaw",
  controlTitle: "JSClaw Control",
  logos: {
    favicon: "/favicon.ico",
    appleTouchIcon: "/apple-touch-icon.png",
    logo: "/favicon.svg"
  }
};
