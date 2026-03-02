export {
  createCharacter,
  updateCharacter,
  getCharacterSprite,
  isReadingTool,
} from "./characters.js";
export { WorldState } from "./world-state.js";
export { startGameLoop } from "./game-loop.js";
export type { GameLoopCallbacks } from "./game-loop.js";
export { renderFrame, renderTileGrid, renderScene, renderBubbles } from "./renderer.js";
