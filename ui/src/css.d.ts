/// <reference types="vite/client" />

declare module "*.css";

declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

declare module "*.css?inline" {
  const css: string;
  export default css;
}

declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*?url&no-inline" {
  const url: string;
  export default url;
}
