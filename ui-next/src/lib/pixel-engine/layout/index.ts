export {
  FURNITURE_CATALOG,
  getCatalogEntry,
  getCatalogByCategory,
  FURNITURE_CATEGORIES,
} from "./furniture-catalog.js";
export type { FurnitureCategory, CatalogEntryWithCategory } from "./furniture-catalog.js";
export {
  layoutToTileMap,
  layoutToFurnitureInstances,
  getBlockedTiles,
  layoutToSeats,
  getSeatTiles,
  createDefaultLayout,
  serializeLayout,
  deserializeLayout,
} from "./layout-serializer.js";
export { isWalkable, getWalkableTiles, findPath } from "./tile-map.js";
