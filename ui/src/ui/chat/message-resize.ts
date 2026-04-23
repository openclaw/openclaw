import { getSafeLocalStorage } from "../../local-storage.ts";
export type ResizeDirection = 'bottom-right' | 'bottom-left';
export interface ResizeState {
  width: number | null;
  height: number | null;
}
const RESIZE_STORAGE_KEY = 'chat:message_sizes';
export function getStoredMessageSize(messageId: string): ResizeState | null {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {return null;}
    const sizes = JSON.parse(storage.getItem(RESIZE_STORAGE_KEY) || '{}');
    return sizes[messageId] || null;
  } catch {
    return null;
  }
}
export function storeMessageSize(messageId: string, size: ResizeState) {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    const sizes = JSON.parse(storage.getItem(RESIZE_STORAGE_KEY) || '{}');
    sizes[messageId] = size;
    storage.setItem(RESIZE_STORAGE_KEY, JSON.stringify(sizes));
  } catch (e) {
    console.error('Failed to store size:', e);
  }
}

export function setupResizeHandles(
  container: HTMLElement,
  direction: ResizeDirection,
  messageId: string,
  onResize?: (width: number, height: number) => void
) {
  // Remove any existing handles
  const existingHandles = container.querySelectorAll('.chat-resize-handle');
  existingHandles.forEach(handle => handle.remove());

  // Force container to be relative and have proper sizing
  container.style.position = 'relative';
  container.style.display = 'block';
  
const handleRight = document.createElement('div');
handleRight.className = 'chat-resize-handle chat-resize-handle--bottom-right';
handleRight.setAttribute('aria-label', 'Resize from bottom right');
handleRight.style.position = 'absolute';
handleRight.style.bottom = '-8px';
handleRight.style.right = '-8px';
handleRight.style.width = '8px';
handleRight.style.height = '8px';
handleRight.style.cursor = 'se-resize';
handleRight.style.backgroundColor = '#3b82f6';
handleRight.style.zIndex = '9999';
handleRight.style.borderRadius = '2px';
handleRight.style.opacity = '0';
handleRight.style.transition = 'opacity 0.2s';
handleRight.style.pointerEvents = 'auto';
handleRight.style.border = '1px solid white';

 
  container.appendChild(handleRight);

  let isResizing = false;
  let startX = 0, startY = 0;
  let startWidth = 0, startHeight = 0;
  let currentHandle: HTMLElement | null = null;

  const showHandles = () => {
    if (!isResizing) {
      handleRight.style.opacity = '0.8';
    }
  };
  
  const hideHandles = () => {
    if (!isResizing) {
      handleRight.style.opacity = '0';
    }
  };
  
  container.addEventListener('mouseenter', showHandles);
  container.addEventListener('mouseleave', hideHandles);
  
  handleRight.addEventListener('mouseenter', () => {
    handleRight.style.opacity = '1';
    handleRight.style.backgroundColor = '#2563eb';
  });
  
  handleRight.addEventListener('mouseleave', () => {
    if (!isResizing && container.matches(':hover')) {
      handleRight.style.opacity = '0.8';
      handleRight.style.backgroundColor = '#3b82f6';
    } else if (!isResizing) {
      handleRight.style.opacity = '0';
    }
  });
  
  function onMouseMove(e: MouseEvent) {
    if (!isResizing || !currentHandle) {return;}
    e.preventDefault();
    e.stopPropagation();
    
    let newWidth = startWidth;
    let newHeight = startHeight;
    
    if (currentHandle.classList.contains('chat-resize-handle--bottom-right')) {
      newWidth = startWidth + (e.clientX - startX);
      newHeight = startHeight + (e.clientY - startY);
    } else if (currentHandle.classList.contains('chat-resize-handle--bottom-left')) {
      newWidth = startWidth - (e.clientX - startX);
      newHeight = startHeight + (e.clientY - startY);
    }
    
    const minWidth = 200;
    const maxWidth = 1024;
    const minHeight = 100;
    
    newWidth = Math.min(Math.max(newWidth, minWidth), maxWidth);
    newHeight = Math.max(newHeight, minHeight);
    
    container.style.width = `${newWidth}px`;
    // Removed: container.style.height = `${newHeight}px`;
    
    if (onResize) {
      onResize(newWidth, newHeight);
    }
  }

function onMouseUp() {
  isResizing = false;
  currentHandle = null;
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  
  if (container.style.width) {
    const newWidth = parseInt(container.style.width);
    container.style.height = 'auto';
    storeMessageSize(messageId, {
      width: newWidth,
      height: null  // Keep height as null (original behavior)
    });
  } else {
    console.log('No container.style.width found');
  }
  
  if (!container.matches(':hover')) {
    handleRight.style.opacity = '0';
  } else {
    handleRight.style.opacity = '0.8';
  }
}

  function startResize(e: MouseEvent, handle: HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    currentHandle = handle;
    startX = e.clientX;
    startY = e.clientY;
    startWidth = container.offsetWidth;
    startHeight = container.offsetHeight;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = handle.style.cursor;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  handleRight.addEventListener('mousedown', (e) => startResize(e, handleRight));

  return { 
    cleanup: () => {
      handleRight.remove();
      container.removeEventListener('mouseenter', showHandles);
      container.removeEventListener('mouseleave', hideHandles);
    } 
  };
}