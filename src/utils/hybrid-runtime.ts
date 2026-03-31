import os from "node:os";
import { execSync } from "node:child_process";

/**
 * Hybrid Runtime Optimization for Apple Silicon (M4)
 * 
 * This module provides utilities for optimizing ML workloads across CPU, GPU, and ANE
 * using Apple's Core ML framework. Optimized for maximum performance utilizing all available cores.
 */

/**
 * Detect if running on Apple Silicon with Neural Engine (M1 Pro/Max/Ultra, M2 Pro/Max/Ultra, M3 Pro/Max/Ultra, M4 Pro/Max/Ultra)
 */
export function hasNeuralEngine(): boolean {
  if (!isAppleSilicon()) {
    return false;
  }

  try {
    const cpuBrand = execSync("sysctl -n machdep.cpu.brand_string 2>/dev/null", {
      encoding: "utf8",
    }).trim();

    // M1 base (no Neural Engine) vs Pro/Max/Ultra (with Neural Engine)
    if (cpuBrand.includes("Apple M1")) {
      return cpuBrand.includes("Apple M1 Pro") || 
             cpuBrand.includes("Apple M1 Max") || 
             cpuBrand.includes("Apple M1 Ultra");
    }

    // M2 base (no Neural Engine) vs Pro/Max/Ultra (with Neural Engine)
    if (cpuBrand.includes("Apple M2")) {
      return cpuBrand.includes("Apple M2 Pro") || 
             cpuBrand.includes("Apple M2 Max") || 
             cpuBrand.includes("Apple M2 Ultra");
    }

    // M3 and M4 Pro/Max/Ultra always have Neural Engine
    if (cpuBrand.includes("Apple M3") || cpuBrand.includes("Apple M4")) {
      return true;
    }

    // Fallback: check if we're on a non-base chip
    return !cpuBrand.includes("Apple M1") || 
           cpuBrand.includes("Apple M1 Pro") ||
           cpuBrand.includes("Apple M1 Max") || 
           cpuBrand.includes("Apple M1 Ultra");
  } catch {
    return false;
  }
}

/**
 * Get Neural Engine core count
 */
export function getNeuralEngineCoreCount(): number {
  if (!hasNeuralEngine()) {
    return 0;
  }

  try {
    const cpuBrand = execSync("sysctl -n machdep.cpu.brand_string 2>/dev/null", {
      encoding: "utf8",
    }).trim();

    if (cpuBrand.includes("Apple M4")) {
      return 16; // M4 has up to 16-core Neural Engine
    }

    if (cpuBrand.includes("Apple M3")) {
      return 16; // M3 has up to 16-core Neural Engine
    }

    if (cpuBrand.includes("Apple M2")) {
      return 16; // M2 Pro/Max/Ultra have 16-core Neural Engine
    }

    if (cpuBrand.includes("Apple M1")) {
      return 16; // M1 Pro/Max/Ultra have 16-core Neural Engine
    }

    return 0;
  } catch {
    return 0;
  }
}

/**
 * Detect if running on Apple Silicon
 */
export function isAppleSilicon(): boolean {
  return process.arch === "arm64" && process.platform === "darwin";
}

/**
 * Get physical CPU core count (performance cores)
 */
export function getPhysicalCpuCount(): number {
  if (process.platform === "darwin" && isAppleSilicon()) {
    try {
      const output = execSync("sysctl -n hw.perflevel0.cpu_count 2>/dev/null || sysctl -n hw.ncpu", {
        encoding: "utf8",
      }).trim();
      const count = parseInt(output, 10);
      if (!isNaN(count) && count > 0) {
        return count;
      }
    } catch {
      // Fall back to logical CPU count
    }
  }

  return os.cpus().length;
}

/**
 * Get performance core count (M1+/M2+/M3+/M4+)
 */
export function getPerformanceCoreCount(): number {
  if (process.platform === "darwin" && isAppleSilicon()) {
    try {
      const output = execSync("sysctl -n hw.perflevel0.cpu_count 2>/dev/null", {
        encoding: "utf8",
      }).trim();
      const count = parseInt(output, 10);
      if (!isNaN(count) && count > 0) {
        return count;
      }
    } catch {
      // Fall back to physical core count
    }
  }

  return getPhysicalCpuCount();
}

/**
 * Get efficiency core count (M1+/M2+/M3+/M4+)
 */
export function getEfficiencyCoreCount(): number {
  if (process.platform === "darwin" && isAppleSilicon()) {
    try {
      const perfCount = execSync("sysctl -n hw.perflevel0.cpu_count 2>/dev/null", {
        encoding: "utf8",
      }).trim();
      const totalCpu = execSync("sysctl -n hw.ncpu 2>/dev/null", {
        encoding: "utf8",
      }).trim();
      
      const perf = parseInt(perfCount, 10);
      const total = parseInt(totalCpu, 10);
      
      if (!isNaN(perf) && !isNaN(total) && total > perf) {
        return total - perf;
      }
    } catch {
      // Fall back to 0
    }
  }

  return 0;
}

/**
 * Get GPU core count (Metal)
 */
export function getGpuCoreCount(): number {
  if (!isAppleSilicon()) {
    return 0;
  }

  try {
    const cpuBrand = execSync("sysctl -n machdep.cpu.brand_string 2>/dev/null", {
      encoding: "utf8",
    }).trim();

    // M4 Pro/Max/Ultra have up to 10-core GPU
    if (cpuBrand.includes("Apple M4")) {
      return 10;
    }

    // M3 Pro/Max/Ultra have up to 10-core GPU
    if (cpuBrand.includes("Apple M3")) {
      return 10;
    }

    // M2 Pro/Max/Ultra have up to 10-core GPU
    if (cpuBrand.includes("Apple M2")) {
      return 10;
    }

    // M1 Pro/Max/Ultra have up to 10-core GPU
    if (cpuBrand.includes("Apple M1")) {
      return 10;
    }

    // Base chips have fewer cores
    if (cpuBrand.includes("Apple M4")) {
      return 8;
    }

    if (cpuBrand.includes("Apple M3")) {
      return 8;
    }

    if (cpuBrand.includes("Apple M2")) {
      return 8;
    }

    if (cpuBrand.includes("Apple M1")) {
      return 7; // Base M1 has 7-core GPU
    }

    return 8;
  } catch {
    return 0;
  }
}

/**
 * Get total available memory (in bytes)
 */
export function getTotalMemory(): number {
  return os.totalmem();
}

/**
 * Get free memory (in bytes)
 */
export function getFreeMemory(): number {
  return os.freemem();
}

/**
 * Get memory usage percentage
 */
export function getMemoryUsagePercentage(): number {
  const total = getTotalMemory();
  const free = getFreeMemory();
  return ((total - free) / total) * 100;
}

/**
 * Hybrid runtime configuration
 */
export interface HybridRuntimeConfig {
  cpuCores: number;
  performanceCoreCount: number;
  efficiencyCoreCount: number;
  gpuCores: number;
  neuralEngineCores: number;
  totalMemory: number;
  freeMemory: number;
  memoryUsagePercentage: number;
  useNeuralEngine: boolean;
  useGpu: boolean;
  useCpu: boolean;
}

/**
 * Get hybrid runtime configuration
 */
export function getHybridRuntimeConfig(): HybridRuntimeConfig {
  const cpuCores = getPhysicalCpuCount();
  const performanceCoreCount = getPerformanceCoreCount();
  const efficiencyCoreCount = getEfficiencyCoreCount();
  const gpuCores = getGpuCoreCount();
  const neuralEngineCores = getNeuralEngineCoreCount();
  const totalMemory = getTotalMemory();
  const freeMemory = getFreeMemory();

  return {
    cpuCores,
    performanceCoreCount,
    efficiencyCoreCount,
    gpuCores,
    neuralEngineCores,
    totalMemory,
    freeMemory,
    memoryUsagePercentage: getMemoryUsagePercentage(),
    useNeuralEngine: neuralEngineCores > 0,
    useGpu: gpuCores > 0,
    useCpu: cpuCores > 0,
  };
}

/**
 * Get optimal parallelization factor based on available resources
 * Uses ALL available cores for maximum performance
 */
export function getOptimalParallelFactor(config?: HybridRuntimeConfig): number {
  const runtimeConfig = config || getHybridRuntimeConfig();

  // Calculate optimal parallelization based on available resources
  // GPU and ANE are much faster than CPU, so they get higher weight
  const totalResources = 
    runtimeConfig.cpuCores * 1 + // CPU cores
    runtimeConfig.gpuCores * 32 + // GPU cores (much faster)
    runtimeConfig.neuralEngineCores * 64; // ANE is fastest for ML

  return Math.max(1, Math.floor(totalResources / 32));
}

/**
 * Get optimal buffer size for hybrid runtime
 */
export function getOptimalBufferSize(config?: HybridRuntimeConfig): number {
  const runtimeConfig = config || getHybridRuntimeConfig();

  // Larger buffers for better throughput on high-core-count systems
  const baseSize = 64 * 1024; // 64KB base
  const multiplier = getOptimalParallelFactor(runtimeConfig);

  return Math.min(baseSize * multiplier, 512 * 1024); // Cap at 512KB
}

/**
 * Get optimal batch size for ML inference based on available resources
 */
export function getOptimalBatchSize(config?: HybridRuntimeConfig): number {
  const runtimeConfig = config || getHybridRuntimeConfig();

  // Calculate optimal batch size based on memory and compute resources
  const availableMemory = runtimeConfig.freeMemory;
  const totalResources = 
    runtimeConfig.cpuCores +
    runtimeConfig.gpuCores +
    runtimeConfig.neuralEngineCores;

  // Base batch size
  let batchSize = Math.max(1, Math.floor(totalResources / 4));

  // Adjust based on memory
  const estimatedMemoryPerSample = 1024 * 1024; // 1MB per sample estimate
  const memoryBasedBatchSize = Math.floor(availableMemory / estimatedMemoryPerSample);

  return Math.min(batchSize, memoryBasedBatchSize);
}

/**
 * Check if Core ML is available
 */
export function hasCoreML(): boolean {
  // On Apple Silicon, Core ML is always available
  return isAppleSilicon();
}

/**
 * Get Core ML device information
 */
export interface CoreMLDevice {
  name: string;
  type: "cpu" | "gpu" | "ane";
  cores: number;
  memory: number;
}

/**
 * Get available Core ML devices
 */
export function getCoreMLDevices(): CoreMLDevice[] {
  const devices: CoreMLDevice[] = [];

  if (hasCoreML()) {
    const config = getHybridRuntimeConfig();

    if (config.cpuCores > 0) {
      devices.push({
        name: "CPU",
        type: "cpu",
        cores: config.cpuCores,
        memory: config.totalMemory,
      });
    }

    if (config.gpuCores > 0) {
      devices.push({
        name: "GPU",
        type: "gpu",
        cores: config.gpuCores,
        memory: config.totalMemory,
      });
    }

    if (config.neuralEngineCores > 0) {
      devices.push({
        name: "ANE",
        type: "ane",
        cores: config.neuralEngineCores,
        memory: config.totalMemory,
      });
    }
  }

  return devices;
}

/**
 * Get optimal device for a given operation
 */
export function getOptimalDevice(operation: string, config?: HybridRuntimeConfig): "cpu" | "gpu" | "ane" {
  const runtimeConfig = config || getHybridRuntimeConfig();

  // ANE is best for neural network operations
  if (runtimeConfig.neuralEngineCores > 0 && 
      (operation.includes("inference") || operation.includes("ml") || operation.includes("nn"))) {
    return "ane";
  }

  // GPU is best for parallel operations
  if (runtimeConfig.gpuCores > 0 && 
      (operation.includes("matrix") || operation.includes("tensor") || operation.includes("parallel"))) {
    return "gpu";
  }

  // CPU for general operations
  return "cpu";
}

/**
 * Get hybrid runtime optimization recommendations
 */
export interface OptimizationRecommendation {
  category: string;
  recommendation: string;
  priority: "low" | "medium" | "high";
  benefit: string;
}

/**
 * Get optimization recommendations for hybrid runtime
 */
export function getOptimizationRecommendations(config?: HybridRuntimeConfig): OptimizationRecommendation[] {
  const runtimeConfig = config || getHybridRuntimeConfig();
  const recommendations: OptimizationRecommendation[] = [];

  // Check ANE usage
  if (runtimeConfig.neuralEngineCores > 0) {
    recommendations.push({
      category: "ANE",
      recommendation: "Use Neural Engine for ML inference workloads",
      priority: "high",
      benefit: "Up to 10x faster inference with lower power consumption",
    });
  }

  // Check GPU usage
  if (runtimeConfig.gpuCores > 0) {
    recommendations.push({
      category: "GPU",
      recommendation: "Use GPU for parallel tensor operations",
      priority: "high",
      benefit: "Significant speedup for matrix operations and training",
    });
  }

  // Check CPU usage
  if (runtimeConfig.cpuCores > 0) {
    recommendations.push({
      category: "CPU",
      recommendation: "Use CPU for preprocessing and postprocessing",
      priority: "medium",
      benefit: "Efficient handling of non-ML tasks",
    });
  }

  // Check memory usage
  if (runtimeConfig.memoryUsagePercentage > 80) {
    recommendations.push({
      category: "Memory",
      recommendation: "Reduce batch size or use memory-efficient operations",
      priority: "high",
      benefit: "Prevent out-of-memory errors and improve stability",
    });
  }

  return recommendations;
}
