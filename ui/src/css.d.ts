declare module "*.css";

declare module "*.css?url" {
  const src: string;
  export default src;
}
