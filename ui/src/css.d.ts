// Control UI type declarations define css contracts.
declare module "*.css";

declare module "*.css?url" {
  const src: string;
  export default src;
}
